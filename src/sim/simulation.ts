/**
 * 河川地形シミュレーション本体。
 *
 * 水の移動は virtual-pipe 法（Mei et al. 2007 を簡略化したもの）を用いる。
 * 隣接セルとの「水面高の差」で仮想パイプの流量を加速し、摩擦で減衰させる。
 * 流量はセル内の水量を超えないようスケーリングされるため、水深は負にならない。
 *
 * 1 サブステップの流れ:
 *   1. 水源からの流入
 *   2. 流束の更新（水面差 → 加速、摩擦 → 減衰、フルード数と保有水量で制限）
 *   3. 水深の更新 ＋ 浮遊土砂の移流（同じ流束を使うので土砂も保存される）
 *   4. 流速の算出
 *   5. 侵食 / 堆積（掃流力と運搬能力から計算し、bedHeight を実際に増減させる）
 *   6. 安息角による崩落
 *   7. 蒸発（既定 0）
 */

import { TerrainGrid } from './grid.ts';
import {
  DEFAULT_PARAMS,
  cloneParams,
  createBudget,
  type Budget,
  type SimParams,
  type StepStats,
  type WaterSource,
} from './types.ts';

/** 排水セルが水を抜く速さ [m/s] */
const DRAIN_SPEED = 4;
/** 侵食計算で使う水面勾配の上限（数値破綻の防止） */
const MAX_SLOPE = 4;

export class Simulation {
  readonly grid: TerrainGrid;
  params: SimParams;
  budget: Budget;
  sources: WaterSource[] = [];
  /** 水量スライダーの値 0..1 */
  inflowScale = 0;
  /** 経過シミュレーション時間 [s] */
  elapsed = 0;

  readonly stats: StepStats = {
    waterVolume: 0,
    sedimentVolume: 0,
    waterError: 0,
    sedimentError: 0,
    wetCells: 0,
    maxDepth: 0,
    maxSpeed: 0,
    erodedVolume: 0,
    depositedVolume: 0,
    substeps: 0,
  };

  constructor(width: number, height: number, params: Partial<SimParams> = {}) {
    this.grid = new TerrainGrid(width, height);
    this.params = { ...cloneParams(DEFAULT_PARAMS), ...params };
    if (params.openBoundary) this.params.openBoundary = { ...params.openBoundary };
    this.budget = createBudget();
  }

  get cellArea(): number {
    return this.params.cellSize * this.params.cellSize;
  }

  /** 地形を確定させたあとに呼び、収支の基準値を作る */
  resetBudget(): void {
    this.budget = createBudget();
    this.budget.waterInitial = this.grid.totalWater(this.cellArea);
    this.budget.sedimentInitial = this.grid.totalSediment(this.cellArea);
    this.elapsed = 0;
    this.refreshStats(0);
  }

  /** 水源からの合計流入量 [m^3/s] */
  currentInflow(): number {
    let sum = 0;
    for (const s of this.sources) sum += s.maxRate;
    return sum * this.inflowScale;
  }

  /**
   * 固定時間刻み dt [s] だけ進める。
   * 内部で CFL 条件に応じたサブステップに分割する。
   */
  step(dt: number): StepStats {
    if (!(dt > 0)) return this.stats;
    this.stats.erodedVolume = 0;
    this.stats.depositedVolume = 0;

    const n = this.computeSubsteps(dt);
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
    this.stats.substeps = n;
    this.elapsed += dt;

    this.decayVisualAccumulators(dt);
    this.refreshStats(dt);
    return this.stats;
  }

  /** CFL条件と仮想パイプの安定条件からサブステップ数を決める */
  private computeSubsteps(dt: number): number {
    const p = this.params;
    const d = this.stats.maxDepth;
    const v = this.stats.maxSpeed;
    const wave = Math.sqrt(p.gravity * Math.max(d, p.minDepth)) + v;
    const dtWave = (p.cfl * p.cellSize) / Math.max(wave, 1e-3);
    // 仮想パイプの陽解法としての安定条件: dt^2 * g * d / (l * cellSize) <= 0.5
    const dtPipe = Math.sqrt(
      (0.5 * p.pipeLength * p.cellSize) / (p.gravity * Math.max(d, p.minDepth)),
    );
    const limit = Math.min(dtWave, dtPipe);
    const n = Math.ceil(dt / Math.max(limit, 1e-4));
    return Math.max(1, Math.min(p.maxSubsteps, n));
  }

  private substep(h: number): void {
    this.addSourceWater(h);
    this.updateFlux(h);
    this.applyFluxAndTransport(h);
    this.updateVelocity();
    this.erodeAndDeposit(h);
    this.applySlippage(h);
    if (this.params.evaporation > 0) this.evaporate(h);
  }

  // ---------------------------------------------------------------- 水源

  private addSourceWater(h: number): void {
    if (this.inflowScale <= 0 || this.sources.length === 0) return;
    const g = this.grid;
    const area = this.cellArea;
    for (const src of this.sources) {
      const rate = src.maxRate * this.inflowScale;
      if (rate <= 0) continue;
      const r = Math.max(0.5, src.radius);
      const x0 = Math.max(0, Math.floor(src.x - r));
      const x1 = Math.min(g.width - 1, Math.ceil(src.x + r));
      const y0 = Math.max(0, Math.floor(src.y - r));
      const y1 = Math.min(g.height - 1, Math.ceil(src.y + r));
      // まず重みの合計を出し、流量を面積で正規化する
      let weightSum = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - src.x;
          const dy = y + 0.5 - src.y;
          const t = 1 - Math.sqrt(dx * dx + dy * dy) / r;
          if (t > 0) weightSum += t;
        }
      }
      if (weightSum <= 0) continue;
      const volume = rate * h; // [m^3]
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - src.x;
          const dy = y + 0.5 - src.y;
          const t = 1 - Math.sqrt(dx * dx + dy * dy) / r;
          if (t <= 0) continue;
          g.waterDepth[g.index(x, y)] += (volume * (t / weightSum)) / area;
        }
      }
      this.budget.waterAdded += volume;
    }
  }

  // ---------------------------------------------------------------- 流束

  private updateFlux(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const bed = g.bedHeight;
    const dep = g.waterDepth;
    const area = this.cellArea;
    const cs = p.cellSize;
    // 重力による加速の係数（断面積は方向ごとの hFlow から決める）
    const accelBase = (h * p.fluxGain * cs * p.gravity) / p.pipeLength;
    // Manning 摩擦（半陰的）の係数
    const fricBase = (h * p.gravity * p.manningN * p.manningN) / cs;
    const froude = p.froudeMax * cs;
    const ob = p.openBoundary;
    const hMin = 4e-3;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = dep[i];

        // 乾いたセルは流束を落とす（境界での数値破綻を避ける）
        if (d <= p.minDepth) {
          g.fluxL[i] = 0;
          g.fluxR[i] = 0;
          g.fluxT[i] = 0;
          g.fluxB[i] = 0;
          continue;
        }

        const bi = bed[i];
        const surf = bi + d;
        let total = 0;

        for (let k = 0; k < 4; k++) {
          let j = -1;
          let open = false;
          if (k === 0) {
            if (x > 0) j = i - 1;
            else open = ob.left;
          } else if (k === 1) {
            if (x < width - 1) j = i + 1;
            else open = ob.right;
          } else if (k === 2) {
            if (y > 0) j = i - width;
            else open = ob.top;
          } else {
            if (y < height - 1) j = i + width;
            else open = ob.bottom;
          }

          let dh: number;
          let hFlow: number;
          if (j >= 0) {
            const bj = bed[j];
            const surfJ = bj + dep[j];
            dh = surf - surfJ;
            // 流出側（このセル）の水面から見た有効水深。
            // 隣の地盤がこのセルの水面より高ければ 0 になり、堤を越えて流れない。
            hFlow = surf - (bi > bj ? bi : bj);
          } else if (open) {
            // 盤面外へは自由落下。外の水面 = 縁の地盤高とみなす
            dh = d;
            hFlow = d;
          } else {
            dh = 0;
            hFlow = 0;
          }

          let f = k === 0 ? g.fluxL[i] : k === 1 ? g.fluxR[i] : k === 2 ? g.fluxT[i] : g.fluxB[i];

          if (hFlow <= 0) {
            f = 0;
          } else {
            // 重力加速: df = dt * A * g * dh / l,  A = fluxGain * cellSize * hFlow
            f += accelBase * hFlow * dh;
            if (f < 0) f = 0;
            if (f > 0) {
              // Manning 摩擦: f_new = f / (1 + K f),  K = dt*g*n^2 / (cellSize * hFlow^(7/3))
              const he = hFlow > hMin ? hFlow : hMin;
              const h73 = he * he * Math.cbrt(he);
              f = f / (1 + (fricBase / h73) * f);
              // フルード数制限（超臨界流の暴走防止）
              const fmax = froude * Math.sqrt(p.gravity * hFlow) * hFlow;
              if (f > fmax) f = fmax;
              if (!(f >= 0)) f = 0;
            }
          }

          total += f;
          if (k === 0) g.fluxL[i] = f;
          else if (k === 1) g.fluxR[i] = f;
          else if (k === 2) g.fluxT[i] = f;
          else g.fluxB[i] = f;
        }

        // セル内の水量を超えて流出させない
        const outVol = total * h;
        if (outVol > 0) {
          const capacity = d * area;
          if (outVol > capacity) {
            const kk = capacity / outVol;
            g.fluxL[i] *= kk;
            g.fluxR[i] *= kk;
            g.fluxT[i] *= kk;
            g.fluxB[i] *= kk;
          }
        }
      }
    }
  }

  /**
   * 流束から水深を更新し、同じ流束で浮遊土砂を移流させる。
   * 土砂は「水の移動量に比例して」しか動かないため、砂だけが瞬間移動することはない。
   */
  private applyFluxAndTransport(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const area = this.cellArea;
    const dep = g.waterDepth;
    const sed = g.suspendedSediment;
    const conc = g.scratchDelta; // 単位体積あたりの土砂（高さ換算）
    const newDepth = g.scratchDepth;
    const newSed = g.scratchSediment;
    const fl = g.fluxL;
    const fr = g.fluxR;
    const ft = g.fluxT;
    const fb = g.fluxB;

    for (let i = 0; i < g.size; i++) {
      const d = dep[i];
      conc[i] = d > p.minDepth ? sed[i] / (d * area) : 0;
    }

    let waterOut = 0;
    let sedimentOut = 0;
    let faults = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const outVol = (fl[i] + fr[i] + ft[i] + fb[i]) * h;
        let inVol = 0;
        let inSed = 0;

        if (x > 0) {
          const j = i - 1;
          const v = fr[j] * h;
          inVol += v;
          inSed += conc[j] * v;
        }
        if (x < width - 1) {
          const j = i + 1;
          const v = fl[j] * h;
          inVol += v;
          inSed += conc[j] * v;
        }
        if (y > 0) {
          const j = i - width;
          const v = fb[j] * h;
          inVol += v;
          inSed += conc[j] * v;
        }
        if (y < height - 1) {
          const j = i + width;
          const v = ft[j] * h;
          inVol += v;
          inSed += conc[j] * v;
        }

        // 盤面外へ出た分を記録
        let escaped = 0;
        if (x === 0) escaped += fl[i] * h;
        if (x === width - 1) escaped += fr[i] * h;
        if (y === 0) escaped += ft[i] * h;
        if (y === height - 1) escaped += fb[i] * h;
        if (escaped > 0) {
          waterOut += escaped;
          sedimentOut += conc[i] * escaped * area;
        }

        const outSed = conc[i] * outVol;
        let nd = dep[i] + (inVol - outVol) / area;
        let ns = sed[i] - outSed + inSed;

        if (!(nd >= 0)) {
          nd = 0;
          faults++;
        }
        if (!(ns >= 0)) {
          ns = 0;
          faults++;
        }
        newDepth[i] = nd;
        newSed[i] = ns;
      }
    }

    // 排水セル: 水と浮遊土砂を盤面外へ捨てる
    for (let i = 0; i < g.size; i++) {
      let d = newDepth[i];
      if (g.drain[i] === 1 && d > 0) {
        const removed = Math.min(d, DRAIN_SPEED * h);
        const frac = removed / d;
        const s = newSed[i] * frac;
        newDepth[i] = d - removed;
        newSed[i] -= s;
        waterOut += removed * area;
        sedimentOut += s * area;
        d = newDepth[i];
      }
      g.waterDepth[i] = newDepth[i];
      g.suspendedSediment[i] = newSed[i];
    }

    this.budget.waterOut += waterOut;
    this.budget.sedimentOut += sedimentOut;
    this.budget.numericFaults += faults;
  }

  /** 流束から流速ベクトルを求める */
  private updateVelocity(): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const dep = g.waterDepth;
    const fl = g.fluxL;
    const fr = g.fluxR;
    const ft = g.fluxT;
    const fb = g.fluxB;
    const eps = Math.max(p.minDepth, 1e-4);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = dep[i];
        if (d <= p.minDepth) {
          g.velocityX[i] = 0;
          g.velocityY[i] = 0;
          continue;
        }
        const leftIn = x > 0 ? fr[i - 1] : 0;
        const rightIn = x < width - 1 ? fl[i + 1] : 0;
        const topIn = y > 0 ? fb[i - width] : 0;
        const bottomIn = y < height - 1 ? ft[i + width] : 0;

        const dWx = (leftIn - fl[i] + fr[i] - rightIn) * 0.5;
        const dWy = (topIn - ft[i] + fb[i] - bottomIn) * 0.5;

        const denom = p.cellSize * Math.max(d, eps);
        let vx = dWx / denom;
        let vy = dWy / denom;
        if (!Number.isFinite(vx)) vx = 0;
        if (!Number.isFinite(vy)) vy = 0;
        g.velocityX[i] = vx;
        g.velocityY[i] = vy;
      }
    }
  }

  // ------------------------------------------------------- 侵食・堆積

  private erodeAndDeposit(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const bed = g.bedHeight;
    const rock = g.bedrockHeight;
    const dep = g.waterDepth;
    const sed = g.suspendedSediment;
    const area = this.cellArea;
    const morph = p.morphologicalTimeScale;
    const inv2dx = 1 / (2 * p.cellSize);

    let eroded = 0;
    let deposited = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = dep[i];
        const s = sed[i];

        if (d <= p.minDepth) {
          // 乾いたセルに浮遊土砂は残せない。ゆっくり落として地盤に戻す
          if (s > 0) {
            const drop = Math.min(s, s * p.dryDepositionRate * morph * h + 1e-7);
            bed[i] += drop;
            sed[i] = s - drop;
            g.depositedSediment[i] += drop;
            g.depositionRecent[i] += drop;
            deposited += drop * area;
          }
          continue;
        }

        // 水面勾配（中央差分）
        const xm = x > 0 ? i - 1 : i;
        const xp = x < width - 1 ? i + 1 : i;
        const ym = y > 0 ? i - width : i;
        const yp = y < height - 1 ? i + width : i;
        const sx = (bed[xp] + dep[xp] - (bed[xm] + dep[xm])) * inv2dx;
        const sy = (bed[yp] + dep[yp] - (bed[ym] + dep[ym])) * inv2dx;
        let slope = Math.sqrt(sx * sx + sy * sy);
        if (!(slope >= 0)) slope = 0;
        if (slope > MAX_SLOPE) slope = MAX_SLOPE;

        const vx = g.velocityX[i];
        const vy = g.velocityY[i];
        const speed = Math.sqrt(vx * vx + vy * vy);

        // 掃流力 τ = ρ g d S
        const shear = p.density * p.gravity * d * slope;

        // 運搬能力 C = k * d * speed^p * (S+eps)^q （濃度上限つき）
        let capacity =
          p.capacityRate *
          d *
          Math.pow(speed, p.speedExponent) *
          Math.pow(slope + p.minSlope, p.slopeExponent);
        const capLimit = p.maxConcentration * d;
        if (capacity > capLimit) capacity = capLimit;
        if (!(capacity >= 0)) capacity = 0;

        if (s < capacity) {
          // --- 侵食 ---
          const excess = shear - p.criticalShear;
          if (excess > 0) {
            let e = p.erosionRate * excess * g.erodibility[i] * morph * h;
            const rateCap = p.maxErosionRate * morph * h;
            if (e > rateCap) e = rateCap;
            const deficit = capacity - s;
            if (e > deficit) e = deficit;
            const available = bed[i] - rock[i];
            if (e > available) e = available;
            if (e > 0) {
              bed[i] -= e;
              sed[i] = s + e;
              g.erosionRecent[i] += e;
              eroded += e * area;
            }
          }
        } else {
          // --- 堆積 ---
          let dp = p.depositionRate * (s - capacity) * morph * h;
          if (dp > s) dp = s;
          if (dp > 0) {
            bed[i] += dp;
            sed[i] = s - dp;
            g.depositedSediment[i] += dp;
            g.depositionRecent[i] += dp;
            deposited += dp * area;
          }
        }
      }
    }

    this.stats.erodedVolume += eroded;
    this.stats.depositedVolume += deposited;
  }

  // ------------------------------------------------------------ 崩落

  /**
   * 安息角を超えた斜面を崩す（thermal erosion）。
   * 一度に全部は崩さず、複数ステップで自然に落ち着かせる。土砂量は厳密に保存する。
   */
  private applySlippage(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const bed = g.bedHeight;
    const rock = g.bedrockHeight;
    const dep = g.waterDepth;
    const delta = g.scratchDelta;
    delta.fill(0);

    const dxs = [-1, 1, 0, 0];
    const dys = [0, 0, -1, 1];
    const excess = [0, 0, 0, 0];
    const rate = Math.min(1, p.slippageRate * h);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const bi = bed[i];
        const avail = bi - rock[i];
        if (avail <= 0) continue;

        // 水を含むほど安息角は小さく（崩れやすく）なる
        const wet = Math.min(1, dep[i] / 0.05);
        const maxDrop = (p.reposeTanDry + (p.reposeTanWet - p.reposeTanDry) * wet) * p.cellSize;

        let sum = 0;
        let maxExcess = 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + dxs[k];
          const ny = y + dys[k];
          let e = 0;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
            e = bi - bed[ny * width + nx] - maxDrop;
            if (e < 0) e = 0;
          }
          excess[k] = e;
          sum += e;
          if (e > maxExcess) maxExcess = e;
        }
        if (sum <= 0) continue;

        // 一度に動かす量: 速度制限・過剰量の半分・掘れる残量 の最小
        let move = rate * sum;
        const half = 0.5 * maxExcess;
        if (move > half) move = half;
        if (move > avail) move = avail;
        if (move <= 0) continue;

        delta[i] -= move;
        const inv = move / sum;
        for (let k = 0; k < 4; k++) {
          if (excess[k] <= 0) continue;
          const nx = x + dxs[k];
          const ny = y + dys[k];
          delta[ny * width + nx] += excess[k] * inv;
        }
      }
    }

    for (let i = 0; i < g.size; i++) {
      if (delta[i] !== 0) bed[i] += delta[i];
    }
  }

  private evaporate(h: number): void {
    const g = this.grid;
    const p = this.params;
    const area = this.cellArea;
    let lost = 0;
    for (let i = 0; i < g.size; i++) {
      const d = g.waterDepth[i];
      if (d <= 0) continue;
      const e = Math.min(d, p.evaporation * h);
      g.waterDepth[i] = d - e;
      lost += e;
    }
    this.budget.waterEvaporated += lost * area;
  }

  // ------------------------------------------------------------ 統計

  private decayVisualAccumulators(dt: number): void {
    const g = this.grid;
    const k = Math.max(0, 1 - 2.5 * dt);
    for (let i = 0; i < g.size; i++) {
      g.erosionRecent[i] *= k;
      g.depositionRecent[i] *= k;
    }
  }

  private refreshStats(_dt: number): void {
    const g = this.grid;
    const area = this.cellArea;
    let water = 0;
    let sediment = 0;
    let wet = 0;
    let maxDepth = 0;
    let maxSpeed = 0;
    const minDepth = this.params.minDepth;

    for (let i = 0; i < g.size; i++) {
      const d = g.waterDepth[i];
      water += d;
      sediment += g.bedHeight[i] + g.suspendedSediment[i];
      if (d > minDepth) {
        wet++;
        if (d > maxDepth) maxDepth = d;
        const vx = g.velocityX[i];
        const vy = g.velocityY[i];
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp > maxSpeed) maxSpeed = sp;
      }
    }

    const st = this.stats;
    const b = this.budget;
    st.waterVolume = water * area;
    st.sedimentVolume = sediment * area;
    st.wetCells = wet;
    st.maxDepth = maxDepth;
    st.maxSpeed = maxSpeed;
    st.waterError =
      st.waterVolume - (b.waterInitial + b.waterAdded - b.waterOut - b.waterEvaporated);
    st.sedimentError =
      st.sedimentVolume - (b.sedimentInitial + b.sandAdded - b.sandRemoved - b.sedimentOut);
  }

  // -------------------------------------------------- プレイヤーの編集

  /**
   * 砂を盛る / 削る。
   * @param cx セル座標 x
   * @param cy セル座標 y
   * @param radius 半径 [セル]
   * @param amount 中心での高さ変化 [m]（正で盛る、負で削る）
   * @returns 実際に増減した体積 [m^3]（正で盛った量）
   */
  modifyTerrain(cx: number, cy: number, radius: number, amount: number): number {
    const g = this.grid;
    const r = Math.max(0.5, radius);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(g.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(g.height - 1, Math.ceil(cy + r));
    let changed = 0;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const t = 1 - Math.sqrt(dx * dx + dy * dy) / r;
        if (t <= 0) continue;
        // 中心ほど大きく変化する滑らかなブラシ
        const w = t * t * (3 - 2 * t);
        const i = g.index(x, y);
        let delta = amount * w;
        if (delta < 0) {
          const avail = g.bedHeight[i] - g.bedrockHeight[i];
          if (avail <= 0) continue;
          if (-delta > avail) delta = -avail;
        }
        g.bedHeight[i] += delta;
        changed += delta;
      }
    }

    const volume = changed * this.cellArea;
    if (volume > 0) this.budget.sandAdded += volume;
    else this.budget.sandRemoved += -volume;
    return volume;
  }

  /** デバッグ用: 収支の誤差が許容範囲を超えていないか */
  budgetWithinTolerance(tolerance = 1e-4): boolean {
    const scale = Math.max(1, this.stats.waterVolume, this.stats.sedimentVolume);
    return (
      Math.abs(this.stats.waterError) / scale < tolerance &&
      Math.abs(this.stats.sedimentError) / scale < tolerance
    );
  }

  /** NaN / 負値の検査と修復。開発時の検出用 */
  validate(): { faults: number; repaired: boolean } {
    const g = this.grid;
    let faults = 0;
    for (let i = 0; i < g.size; i++) {
      if (!Number.isFinite(g.bedHeight[i])) {
        g.bedHeight[i] = g.bedrockHeight[i];
        faults++;
      }
      if (!(g.waterDepth[i] >= 0)) {
        g.waterDepth[i] = 0;
        faults++;
      }
      if (!(g.suspendedSediment[i] >= 0)) {
        g.suspendedSediment[i] = 0;
        faults++;
      }
      if (!Number.isFinite(g.velocityX[i])) {
        g.velocityX[i] = 0;
        faults++;
      }
      if (!Number.isFinite(g.velocityY[i])) {
        g.velocityY[i] = 0;
        faults++;
      }
    }
    this.budget.numericFaults += faults;
    return { faults, repaired: faults > 0 };
  }
}

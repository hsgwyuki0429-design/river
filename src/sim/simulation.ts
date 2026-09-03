/**
 * 河川地形シミュレーション本体。
 *
 * 水の移動は virtual-pipe 法（Mei et al. 2007 を簡略化したもの）を用いる。
 * 隣接セルとの「水面高の差」で仮想パイプの流量を加速し、摩擦で減衰させる。
 * 流量はセル内の水量を超えないようスケーリングされるため、水深は負にならない。
 *
 * 1 サブステップの流れ:
 *   1. 水源からの流入、または有限循環タンクからの再投入
 *   2. 4/8近傍流束の更新（水面差 → 加速、Manning摩擦 → 減衰）
 *   3. 水深の更新 ＋ 浮遊土砂の移流（同じ流束を使うので土砂も保存される）
 *   4. 流速の算出
 *   5. 平滑化流向・曲率・遅れた二次流
 *   6. 侵食 / 堆積・外岸侵食・内岸堆積・掃流砂移動
 *   7. 安息角による崩落
 *   8. 蒸発（既定 0）
 */

import { TerrainGrid } from './grid.ts';
import {
  DEFAULT_PARAMS,
  cloneParams,
  createBudget,
  type Budget,
  type CirculationState,
  type SimParams,
  type StepStats,
  type WaterSource,
} from './types.ts';

/** 排水セルが水を抜く速さ [m/s] */
const DRAIN_SPEED = 4;
/** 侵食計算で使う水面勾配の上限（数値破綻の防止） */
const MAX_SLOPE = 4;
const SQRT2 = Math.SQRT2;
const DIR_X = new Int8Array([-1, 1, 0, 0, -1, 1, -1, 1]);
const DIR_Y = new Int8Array([0, 0, -1, 1, -1, -1, 1, 1]);
const DIR_LEN = new Float32Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);
const DIR_WEIGHT = new Float32Array([1, 1, 1, 1, 1 / SQRT2, 1 / SQRT2, 1 / SQRT2, 1 / SQRT2]);
const OPPOSITE = new Int8Array([1, 0, 3, 2, 7, 6, 5, 4]);

export class Simulation {
  readonly grid: TerrainGrid;
  params: SimParams;
  budget: Budget;
  sources: WaterSource[] = [];
  /** 水量スライダーの値 0..1 */
  inflowScale = 0;
  /** 経過シミュレーション時間 [s] */
  elapsed = 0;
  /** 盤面外に置く循環タンク。内部循環なので Budget の追加・流出には数えない。 */
  readonly circulation: CirculationState = {
    water: 0,
    suspendedSediment: 0,
    bedloadSediment: 0,
    releasedWater: 0,
    releasedSediment: 0,
  };
  /** 下端流出の横方向分布を保ったまま上端へ戻す水量 [m^3]。 */
  readonly circulationWaterByColumn: Float64Array;
  /** 地形プリセット名と再現シード（保存用）。 */
  presetId = 'custom';
  randomSeed = 0;
  private oxbowTimer = 0;

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
    circulationWater: 0,
    circulationSediment: 0,
    bedloadVolume: 0,
    sinuosity: 1,
    oxbowCandidates: 0,
  };

  constructor(width: number, height: number, params: Partial<SimParams> = {}) {
    this.grid = new TerrainGrid(width, height);
    this.params = { ...cloneParams(DEFAULT_PARAMS), ...params };
    if (params.openBoundary) this.params.openBoundary = { ...params.openBoundary };
    this.budget = createBudget();
    this.circulationWaterByColumn = new Float64Array(width);
  }

  get cellArea(): number {
    return this.params.cellSize * this.params.cellSize;
  }

  get circulationWater(): number {
    return this.circulation.water;
  }

  get circulationSuspendedSediment(): number {
    return this.circulation.suspendedSediment;
  }

  get circulationBedloadSediment(): number {
    return this.circulation.bedloadSediment;
  }

  /** 地形を確定させたあとに呼び、収支の基準値を作る */
  resetBudget(): void {
    this.budget = createBudget();
    this.budget.waterInitial = this.grid.totalWater(this.cellArea) + this.circulation.water;
    this.budget.sedimentInitial =
      this.grid.totalSediment(this.cellArea) +
      this.circulation.suspendedSediment +
      this.circulation.bedloadSediment;
    this.elapsed = 0;
    this.refreshStats(0);
  }

  /** 循環モード開始時の有限な水・土砂をタンクへ設定する。 */
  seedCirculation(water: number, suspendedSediment = 0, bedloadSediment = 0): void {
    this.circulation.water = Math.max(0, water);
    this.circulation.suspendedSediment = Math.max(0, suspendedSediment);
    this.circulation.bedloadSediment = Math.max(0, bedloadSediment);
    this.circulation.releasedWater = 0;
    this.circulation.releasedSediment = 0;
    const src = this.sources[0];
    if (!src || this.circulation.water <= 0) {
      const perColumn = this.circulation.water / this.grid.width;
      this.circulationWaterByColumn.fill(perColumn);
    } else {
      let sum = 0;
      const sigma = Math.max(2, src.radius * 1.8);
      for (let x = 0; x < this.grid.width; x++) {
        const dx = (x + 0.5 - src.x) / sigma;
        const w = Math.exp(-0.5 * dx * dx) + 0.015;
        this.circulationWaterByColumn[x] = w;
        sum += w;
      }
      for (let x = 0; x < this.grid.width; x++) {
        this.circulationWaterByColumn[x] *= this.circulation.water / sum;
      }
    }
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
    this.oxbowTimer += dt;
    if (this.oxbowTimer >= 0.5) {
      this.detectOxbows(this.oxbowTimer);
      this.oxbowTimer = 0;
    }
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
    if (this.params.circulationEnabled) this.releaseCirculation(h);
    else this.addSourceWater(h);
    this.updateFlux(h);
    this.applyFluxAndTransport(h);
    this.updateVelocity();
    if (this.params.meanderDynamics) this.updateFlowGeometry(h);
    this.erodeAndDeposit(h);
    if (this.params.meanderDynamics) {
      this.applyBankProcesses(h);
      this.transportBedload(h);
    }
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

  /**
   * タンクの水を上端へ戻す。水と各土砂相は同じ released/tank 比で放出するため、
   * 水だけ・砂だけが先行しない。下端で記録した横分布は近傍平均で滑らかにして使う。
   */
  private releaseCirculation(h: number): void {
    const tank = this.circulation;
    if (this.inflowScale <= 0 || tank.water <= 0 || this.sources.length === 0) return;
    const before = tank.water;
    const requested = this.currentInflow() * h;
    const releasedWater = Math.min(before, Math.max(0, requested));
    if (releasedWater <= 0) return;
    const fraction = releasedWater / before;
    const releasedSuspended = tank.suspendedSediment * fraction;
    const releasedBedload = tank.bedloadSediment * fraction;
    const g = this.grid;
    const area = this.cellArea;
    const byCol = this.circulationWaterByColumn;
    let columnTotal = 0;
    for (let x = 0; x < g.width; x++) columnTotal += byCol[x];
    const useRecorded = columnTotal > 1e-12;
    const mean = useRecorded ? columnTotal / g.width : 1 / g.width;
    const spread = Math.max(0, Math.min(1, this.params.circulationSpread));
    let weightTotal = 0;
    const weights = g.scratchDelta;
    for (let x = 0; x < g.width; x++) {
      const l = useRecorded ? byCol[x > 0 ? x - 1 : x] : mean;
      const c = useRecorded ? byCol[x] : mean;
      const r = useRecorded ? byCol[x + 1 < g.width ? x + 1 : x] : mean;
      const smooth = (l + 2 * c + r) * 0.25;
      const w = (1 - spread) * c + spread * smooth + mean * 0.02;
      weights[x] = w;
      weightTotal += w;
    }
    if (weightTotal <= 0) weightTotal = g.width;

    for (let x = 0; x < g.width; x++) {
      const share = (weightTotal > 0 ? weights[x] / weightTotal : 1 / g.width);
      const water = releasedWater * share;
      const susp = releasedSuspended * share;
      const bedload = releasedBedload * share;
      // 2列に分け、上端一列への集中と格子ノイズを抑える。
      const i0 = x;
      const i1 = g.height > 1 ? g.width + x : i0;
      g.waterDepth[i0] += (water * 0.72) / area;
      g.suspendedSediment[i0] += (susp * 0.72) / area;
      g.bedloadSediment[i0] += (bedload * 0.72) / area;
      g.waterDepth[i1] += (water * 0.28) / area;
      g.suspendedSediment[i1] += (susp * 0.28) / area;
      g.bedloadSediment[i1] += (bedload * 0.28) / area;
      if (useRecorded) byCol[x] = Math.max(0, byCol[x] * (1 - fraction));
    }
    tank.water -= releasedWater;
    tank.suspendedSediment -= releasedSuspended;
    tank.bedloadSediment -= releasedBedload;
    tank.releasedWater += releasedWater;
    tank.releasedSediment += releasedSuspended + releasedBedload;
    if (tank.water < 1e-12) tank.water = 0;
    if (tank.suspendedSediment < 1e-12) tank.suspendedSediment = 0;
    if (tank.bedloadSediment < 1e-12) tank.bedloadSediment = 0;
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
    const accelBase = h * p.fluxGain * cs * p.gravity;
    const fricBase = h * p.gravity * p.manningN * p.manningN;
    const froude = p.froudeMax * cs;
    const ob = p.openBoundary;
    const hMin = 4e-3;
    const fluxes = g.fluxes;
    const directionCount = p.diagonalFlowEnabled ? 8 : 4;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = dep[i];

        if (d <= p.minDepth) {
          for (let k = 0; k < directionCount; k++) fluxes[k][i] = 0;
          continue;
        }

        const bi = bed[i];
        const surf = bi + d;
        let total = 0;

        for (let k = 0; k < directionCount; k++) {
          const nx = x + DIR_X[k];
          const ny = y + DIR_Y[k];
          let j = -1;
          let open = false;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            j = ny * width + nx;
          } else {
            if (nx < 0 && ob.left) open = true;
            if (nx >= width && ob.right) open = true;
            if (ny < 0 && ob.top) open = true;
            if (ny >= height && (ob.bottom || p.circulationEnabled)) open = true;
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

          let f = fluxes[k][i];

          if (hFlow <= 0) {
            f = 0;
          } else {
            const pipeLength = p.pipeLength * DIR_LEN[k];
            // 斜めは距離 sqrt(2)、接続幅 1/sqrt(2) とし、コピー流束の過剰を防ぐ。
            f += (accelBase * DIR_WEIGHT[k] * hFlow * dh) / pipeLength;
            if (f < 0) f = 0;
            if (f > 0) {
              const he = hFlow > hMin ? hFlow : hMin;
              const h73 = he * he * Math.cbrt(he);
              f = f / (1 + (fricBase * DIR_LEN[k] / (cs * h73)) * f);
              const fmax = froude * DIR_WEIGHT[k] * Math.sqrt(p.gravity * hFlow) * hFlow;
              if (f > fmax) f = fmax;
              if (!(f >= 0)) f = 0;
            }
          }

          total += f;
          fluxes[k][i] = f;
        }

        const outVol = total * h;
        if (outVol > 0) {
          const capacity = d * area;
          if (outVol > capacity) {
            const kk = capacity / outVol;
            for (let k = 0; k < directionCount; k++) fluxes[k][i] *= kk;
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
    const fluxes = g.fluxes;
    const directionCount = p.diagonalFlowEnabled ? 8 : 4;

    for (let i = 0; i < g.size; i++) {
      const d = dep[i];
      conc[i] = d > p.minDepth ? sed[i] / (d * area) : 0;
    }

    let waterOut = 0;
    let sedimentOut = 0;
    let circulatedWater = 0;
    let circulatedSediment = 0;
    let faults = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let outVol = 0;
        let inVol = 0;
        let inSed = 0;
        for (let k = 0; k < directionCount; k++) {
          const vOut = fluxes[k][i] * h;
          outVol += vOut;
          const nx = x + DIR_X[k];
          const ny = y + DIR_Y[k];
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const j = ny * width + nx;
            const vIn = fluxes[OPPOSITE[k]][j] * h;
            inVol += vIn;
            inSed += conc[j] * vIn;
          } else if (vOut > 0) {
            const sedVolume = conc[i] * vOut * area;
            if (p.circulationEnabled && ny >= height) {
              circulatedWater += vOut;
              circulatedSediment += sedVolume;
              this.circulationWaterByColumn[x] += vOut;
            } else {
              waterOut += vOut;
              sedimentOut += sedVolume;
            }
          }
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
    if (circulatedWater > 0) {
      this.circulation.water += circulatedWater;
      this.circulation.suspendedSediment += circulatedSediment;
      this.budget.waterCirculated += circulatedWater;
      this.budget.sedimentCirculated += circulatedSediment;
    }
    this.budget.numericFaults += faults;
  }

  /** 流束から流速ベクトルを求める */
  private updateVelocity(): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const dep = g.waterDepth;
    const fluxes = g.fluxes;
    const directionCount = p.diagonalFlowEnabled ? 8 : 4;
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
        let dWx = 0;
        let dWy = 0;
        for (let k = 0; k < directionCount; k++) {
          const nx = x + DIR_X[k];
          const ny = y + DIR_Y[k];
          const incoming =
            nx >= 0 && nx < width && ny >= 0 && ny < height
              ? fluxes[OPPOSITE[k]][ny * width + nx]
              : 0;
          const net = (fluxes[k][i] - incoming) * 0.5 / DIR_LEN[k];
          dWx += net * DIR_X[k];
          dWy += net * DIR_Y[k];
        }

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

  /** 平滑化流向、符号付き曲率、下流へ遅れて残る二次流を更新する。 */
  updateFlowGeometry(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const sx = g.smoothedVelocityX;
    const sy = g.smoothedVelocityY;
    const dep = g.waterDepth;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let ax = 0;
        let ay = 0;
        let wsum = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= height) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox;
            if (nx < 0 || nx >= width) continue;
            const j = ny * width + nx;
            const vx = g.velocityX[j];
            const vy = g.velocityY[j];
            const speed = Math.sqrt(vx * vx + vy * vy);
            if (speed < p.curvatureMinSpeed || dep[j] <= p.minDepth) continue;
            const w = ox === 0 && oy === 0 ? 4 : ox === 0 || oy === 0 ? 2 : 1;
            ax += (vx / speed) * w;
            ay += (vy / speed) * w;
            wsum += w;
          }
        }
        const mag = Math.sqrt(ax * ax + ay * ay);
        if (wsum <= 0 || mag < 1e-5) {
          sx[i] = 0;
          sy[i] = 0;
          g.flowDirection[i] = 0;
        } else {
          sx[i] = ax / mag;
          sy[i] = ay / mag;
          g.flowDirection[i] = Math.atan2(sy[i], sx[i]);
        }
      }
    }

    const inv2dx = 1 / (2 * p.cellSize);
    const target = g.scratchDelta2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const vx = g.velocityX[i];
        const vy = g.velocityY[i];
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed < p.curvatureMinSpeed || dep[i] <= p.minDepth) {
          g.curvature[i] = 0;
          target[i] = 0;
          continue;
        }
        const xm = x > 0 ? i - 1 : i;
        const xp = x + 1 < width ? i + 1 : i;
        const ym = y > 0 ? i - width : i;
        const yp = y + 1 < height ? i + width : i;
        const tx = sx[i];
        const ty = sy[i];
        const dtxds = tx * (sx[xp] - sx[xm]) * inv2dx + ty * (sx[yp] - sx[ym]) * inv2dx;
        const dtyds = tx * (sy[xp] - sy[xm]) * inv2dx + ty * (sy[yp] - sy[ym]) * inv2dx;
        let curve = tx * dtyds - ty * dtxds;
        if (curve > p.curvatureMax) curve = p.curvatureMax;
        else if (curve < -p.curvatureMax) curve = -p.curvatureMax;
        if (!Number.isFinite(curve)) curve = 0;
        g.curvature[i] = curve;

        const ux = Math.max(0, Math.min(width - 1, Math.round(x - tx)));
        const uy = Math.max(0, Math.min(height - 1, Math.round(y - ty)));
        const upstream = g.secondaryFlow[uy * width + ux];
        target[i] = p.secondaryFlowStrength * (curve * 0.68 + upstream * 0.32);
      }
    }
    const alpha = 1 - Math.exp(-h / Math.max(0.05, p.secondaryFlowRelaxation));
    for (let i = 0; i < g.size; i++) {
      g.secondaryFlow[i] += (target[i] - g.secondaryFlow[i]) * alpha;
    }
  }

  // ------------------------------------------------------- 侵食・堆積

  erodeAndDeposit(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const bed = g.bedHeight;
    const rock = g.bedrockHeight;
    const dep = g.waterDepth;
    const sed = g.suspendedSediment;
    const bedload = g.bedloadSediment;
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

        // 限界掃流力を超えた一部を、河床近傍を動く掃流砂へ移す。
        const bedloadExcess = shear - p.criticalShear;
        if (p.meanderDynamics && bedloadExcess > 0 && morph > 0) {
          let e = p.bedloadRate * bedloadExcess * g.erodibility[i] * morph * h;
          const available = bed[i] - rock[i];
          const cap = p.maxErosionRate * 0.35 * morph * h;
          if (e > cap) e = cap;
          if (e > available) e = available;
          if (e > 0) {
            bed[i] -= e;
            bedload[i] += e;
            g.erosionRecent[i] += e;
            eroded += e * area;
          }
        }

        // 前サブステップで内岸と判定された低速域では点砂州堆積を促進する。
        const currentSediment = sed[i];
        if (g.bankSide[i] < 0 && currentSediment > 0 && morph > 0) {
          const slow = 1 / (1 + speed * speed);
          let dp =
            p.pointBarDepositionGain *
            Math.abs(g.secondaryFlow[i]) *
            slow *
            currentSediment *
            morph *
            h;
          if (dp > currentSediment) dp = currentSediment;
          if (dp > 0) {
            bed[i] += dp;
            sed[i] -= dp;
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

  /** 曲率の符号から外岸・内岸を決め、河岸根元だけを保存的に侵食する。 */
  applyBankProcesses(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const demand = g.scratchDelta;
    demand.fill(0);
    g.bankSide.fill(0);
    const morph = p.morphologicalTimeScale;
    if (morph <= 0) return;

    for (let y = 1; y + 1 < height; y++) {
      for (let x = 1; x + 1 < width; x++) {
        const i = y * width + x;
        const d = g.waterDepth[i];
        const tx = g.smoothedVelocityX[i];
        const ty = g.smoothedVelocityY[i];
        const sec = g.secondaryFlow[i];
        if (d < p.bankWetDepth || Math.abs(sec) < 1e-4 || (tx === 0 && ty === 0)) continue;

        // 正曲率は左曲がりなので外岸は流向右側、負曲率では逆。
        const sign = sec >= 0 ? 1 : -1;
        const outerX = ty * sign;
        const outerY = -tx * sign;
        let outer = -1;
        let inner = -1;
        let bestOuter = -Infinity;
        let bestInner = -Infinity;
        for (let k = 0; k < 8; k++) {
          const dot = (DIR_X[k] * outerX + DIR_Y[k] * outerY) / DIR_LEN[k];
          const j = (y + DIR_Y[k]) * width + x + DIR_X[k];
          if (dot > bestOuter) {
            bestOuter = dot;
            outer = j;
          }
          if (-dot > bestInner) {
            bestInner = -dot;
            inner = j;
          }
        }
        if (inner >= 0) g.bankSide[inner] = -1;
        if (outer < 0) continue;
        g.bankSide[outer] = 1;

        // 水際より高い外岸の根元だけを削る。岩盤下限は適用時にまとめて制限する。
        const bankRise = g.bedHeight[outer] - g.bedHeight[i];
        if (g.waterDepth[outer] > p.bankWetDepth * 1.5 || bankRise < -0.03) continue;
        const vx = g.velocityX[i];
        const vy = g.velocityY[i];
        const speed = Math.sqrt(vx * vx + vy * vy);
        const xm = i - 1;
        const xp = i + 1;
        const ym = i - width;
        const yp = i + width;
        const inv2dx = 1 / (2 * p.cellSize);
        const sx =
          (g.bedHeight[xp] + g.waterDepth[xp] - g.bedHeight[xm] - g.waterDepth[xm]) * inv2dx;
        const sy =
          (g.bedHeight[yp] + g.waterDepth[yp] - g.bedHeight[ym] - g.waterDepth[ym]) * inv2dx;
        const slope = Math.min(MAX_SLOPE, Math.sqrt(sx * sx + sy * sy));
        const shear = p.density * p.gravity * d * slope;
        const excess = shear - p.criticalShear;
        if (excess <= 0) continue;
        let e =
          p.bankErosionRate *
          excess *
          g.erodibility[outer] *
          (1 + p.curvatureErosionGain * Math.abs(sec) * p.cellSize) *
          Math.min(2, d / p.bankWetDepth) *
          (0.35 + Math.min(2, speed)) *
          morph *
          h;
        const rateCap = p.maxErosionRate * 0.45 * morph * h;
        if (e > rateCap) e = rateCap;
        if (e > 0) demand[outer] += e;
      }
    }

    let eroded = 0;
    for (let i = 0; i < g.size; i++) {
      let e = demand[i];
      if (e <= 0) continue;
      const available = g.bedHeight[i] - g.bedrockHeight[i];
      if (e > available) e = available;
      if (e <= 0) continue;
      g.bedHeight[i] -= e;
      g.suspendedSediment[i] += e;
      g.erosionRecent[i] += e;
      g.bankErosionRecent[i] += e;
      eroded += e * this.cellArea;
    }
    this.stats.erodedVolume += eroded;
  }

  /** 主流・下り勾配・内岸向き二次流を合成し、掃流砂を差分バッファで移す。 */
  transportBedload(h: number): void {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const delta = g.scratchDelta;
    delta.fill(0);
    const area = this.cellArea;
    let externalOut = 0;
    let circulationOut = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const q = g.bedloadSediment[i];
        if (q <= 0) continue;
        const xm = x > 0 ? i - 1 : i;
        const xp = x + 1 < width ? i + 1 : i;
        const ym = y > 0 ? i - width : i;
        const yp = y + 1 < height ? i + width : i;
        const inv2dx = 1 / (2 * p.cellSize);
        const downX = -(g.bedHeight[xp] - g.bedHeight[xm]) * inv2dx;
        const downY = -(g.bedHeight[yp] - g.bedHeight[ym]) * inv2dx;
        const tx = g.smoothedVelocityX[i];
        const ty = g.smoothedVelocityY[i];
        const sec = g.secondaryFlow[i];
        const sign = sec >= 0 ? 1 : -1;
        const innerX = -ty * sign;
        const innerY = tx * sign;
        const mx = tx + downX * p.bedSlopeTransportGain + innerX * Math.abs(sec) * p.transverseBedloadGain;
        const my = ty + downY * p.bedSlopeTransportGain + innerY * Math.abs(sec) * p.transverseBedloadGain;
        const mag = Math.sqrt(mx * mx + my * my);
        if (mag < 1e-6) continue;
        let best = -1;
        let bestDot = 0;
        for (let k = 0; k < 8; k++) {
          const dot = (mx * DIR_X[k] + my * DIR_Y[k]) / (mag * DIR_LEN[k]);
          if (dot > bestDot) {
            bestDot = dot;
            best = k;
          }
        }
        if (best < 0) continue;
        let move = q * Math.min(1, p.bedloadTransportRate * h) * bestDot;
        if (move > q) move = q;
        if (move <= 0) continue;
        const nx = x + DIR_X[best];
        const ny = y + DIR_Y[best];
        delta[i] -= move;
        g.bedloadTransportRecent[i] += move;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          delta[ny * width + nx] += move;
        } else if (p.circulationEnabled && ny >= height) {
          circulationOut += move * area;
        } else {
          const open =
            (nx < 0 && p.openBoundary.left) ||
            (nx >= width && p.openBoundary.right) ||
            (ny < 0 && p.openBoundary.top) ||
            (ny >= height && p.openBoundary.bottom);
          if (open) externalOut += move * area;
          else delta[i] += move;
        }
      }
    }
    for (let i = 0; i < g.size; i++) {
      g.bedloadSediment[i] += delta[i];
      if (g.bedloadSediment[i] < 0 && g.bedloadSediment[i] > -1e-7) g.bedloadSediment[i] = 0;
    }
    if (circulationOut > 0) {
      this.circulation.bedloadSediment += circulationOut;
      this.budget.sedimentCirculated += circulationOut;
    }
    this.budget.sedimentOut += externalOut;

    // 低速域、とくに内岸では掃流砂を河床へ戻す。
    let deposited = 0;
    for (let i = 0; i < g.size; i++) {
      const q = g.bedloadSediment[i];
      if (q <= 0) continue;
      const vx = g.velocityX[i];
      const vy = g.velocityY[i];
      const speed = Math.sqrt(vx * vx + vy * vy);
      const inner = g.bankSide[i] < 0 ? 1 + p.pointBarDepositionGain : 1;
      let drop = q * p.bedloadDepositionRate * inner * h / (1 + speed * 1.5);
      if (g.waterDepth[i] <= p.minDepth) drop = Math.max(drop, q * Math.min(1, p.dryDepositionRate * h));
      if (drop > q) drop = q;
      if (drop <= 0) continue;
      g.bedloadSediment[i] -= drop;
      g.bedHeight[i] += drop;
      g.depositedSediment[i] += drop;
      g.depositionRecent[i] += drop;
      deposited += drop * area;
    }
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
          const nx = x + DIR_X[k];
          const ny = y + DIR_Y[k];
          let e = 0;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
            e = bi - bed[ny * width + nx] - maxDrop;
            if (e < 0) e = 0;
          }
          sum += e;
          if (e > maxExcess) maxExcess = e;
        }
        if (sum <= 0) continue;

        // 一度に動かす量: 速度制限・過剰量の半分・掘れる残量 の最小
        // 河岸根元を直前に削られた場所は少し速く、ただし一括崩壊はさせない。
        const bankBoost = g.bankErosionRecent[i] > 1e-6 ? 1.35 : 1;
        let move = rate * bankBoost * sum;
        const half = 0.5 * maxExcess;
        if (move > half) move = half;
        if (move > avail) move = avail;
        if (move <= 0) continue;

        delta[i] -= move;
        const inv = move / sum;
        for (let k = 0; k < 4; k++) {
          const nx = x + DIR_X[k];
          const ny = y + DIR_Y[k];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const e = bi - bed[ny * width + nx] - maxDrop;
          if (e <= 0) continue;
          delta[ny * width + nx] += e * inv;
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

  /**
   * 低速水域を連結成分として検出する読み取り専用パス。
   * 地形・水深は一切変更せず、表示用マスクと統計だけを更新する。
   */
  detectOxbows(dt: number): number {
    const g = this.grid;
    const p = this.params;
    const { width, height } = g;
    const wetDepth = p.oxbowMinDepth;
    for (let i = 0; i < g.size; i++) {
      const vx = g.velocityX[i];
      const vy = g.velocityY[i];
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (g.waterDepth[i] >= wetDepth && speed <= p.oxbowMaxSpeed) {
        g.lowVelocityAge[i] += dt;
      } else {
        g.lowVelocityAge[i] = Math.max(0, g.lowVelocityAge[i] - dt * 2);
      }
    }

    const queue = g.scratchQueue;
    const main = g.mainChannel;
    const visit = g.scratchVisit;
    main.fill(0);
    visit.fill(0);
    g.oxbowCandidate.fill(0);
    let head = 0;
    let tail = 0;
    for (let x = 0; x < width; x++) {
      const i = x;
      if (g.waterDepth[i] >= wetDepth) {
        main[i] = 1;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const y = Math.floor(i / width);
      for (let k = 0; k < 8; k++) {
        const nx = x + DIR_X[k];
        const ny = y + DIR_Y[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (main[j] || g.waterDepth[j] < wetDepth) continue;
        main[j] = 1;
        queue[tail++] = j;
      }
    }

    let count = 0;
    for (let start = 0; start < g.size; start++) {
      if (
        visit[start] ||
        main[start] ||
        g.waterDepth[start] < wetDepth ||
        g.lowVelocityAge[start] < p.oxbowMinAge
      ) continue;
      head = 0;
      tail = 0;
      visit[start] = 1;
      queue[tail++] = start;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      while (head < tail) {
        const i = queue[head++];
        const x = i % width;
        const y = Math.floor(i / width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let k = 0; k < 8; k++) {
          const nx = x + DIR_X[k];
          const ny = y + DIR_Y[k];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (
            visit[j] || main[j] || g.waterDepth[j] < wetDepth ||
            g.lowVelocityAge[j] < p.oxbowMinAge
          ) continue;
          visit[j] = 1;
          queue[tail++] = j;
        }
      }
      const spanX = maxX - minX + 1;
      const spanY = maxY - minY + 1;
      const elongation = Math.max(spanX, spanY) / Math.max(1, Math.min(spanX, spanY));
      if (tail >= p.oxbowMinArea && elongation >= 1.35) {
        count++;
        for (let q = 0; q < tail; q++) g.oxbowCandidate[queue[q]] = 1;
      }
    }
    this.stats.oxbowCandidates = count;
    return count;
  }

  // ------------------------------------------------------------ 統計

  private decayVisualAccumulators(dt: number): void {
    const g = this.grid;
    const k = Math.max(0, 1 - 2.5 * dt);
    for (let i = 0; i < g.size; i++) {
      g.erosionRecent[i] *= k;
      g.depositionRecent[i] *= k;
      g.bankErosionRecent[i] *= k;
      g.bedloadTransportRecent[i] *= k;
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
    let bedload = 0;
    const minDepth = this.params.minDepth;

    for (let i = 0; i < g.size; i++) {
      const d = g.waterDepth[i];
      water += d;
      sediment += g.bedHeight[i] + g.suspendedSediment[i] + g.bedloadSediment[i];
      bedload += g.bedloadSediment[i];
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
    st.circulationWater = this.circulation.water;
    st.circulationSediment =
      this.circulation.suspendedSediment + this.circulation.bedloadSediment;
    st.bedloadVolume = bedload * area;
    st.waterError =
      st.waterVolume + st.circulationWater -
      (b.waterInitial + b.waterAdded - b.waterOut - b.waterEvaporated);
    st.sedimentError =
      st.sedimentVolume + st.circulationSediment -
      (b.sedimentInitial + b.sandAdded - b.sandRemoved - b.sedimentOut);

    // 各行の水深重心を結んだ長さから蛇行度を測る（描画・物理へのフィードバックなし）。
    let path = 0;
    let firstY = -1;
    let lastY = -1;
    let prevX = 0;
    let prevY = 0;
    for (let y = 0; y < g.height; y++) {
      let sum = 0;
      let weightedX = 0;
      const row = y * g.width;
      for (let x = 0; x < g.width; x++) {
        const d = g.waterDepth[row + x];
        if (d <= minDepth) continue;
        sum += d;
        weightedX += (x + 0.5) * d;
      }
      if (sum <= 0) continue;
      const cx = (weightedX / sum) * this.params.cellSize;
      const cy = (y + 0.5) * this.params.cellSize;
      if (firstY < 0) firstY = y;
      if (lastY >= 0) path += Math.hypot(cx - prevX, cy - prevY);
      prevX = cx;
      prevY = cy;
      lastY = y;
    }
    const direct = firstY >= 0 && lastY > firstY ? (lastY - firstY) * this.params.cellSize : 0;
    st.sinuosity = direct > 0 ? Math.max(1, path / direct) : 1;
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
    const waterScale = Math.max(1, this.stats.waterVolume + this.stats.circulationWater);
    const sedimentScale = Math.max(1, this.stats.sedimentVolume + this.stats.circulationSediment);
    return (
      Math.abs(this.stats.waterError) / waterScale < tolerance &&
      Math.abs(this.stats.sedimentError) / sedimentScale < tolerance
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
      if (!(g.bedloadSediment[i] >= 0)) {
        g.bedloadSediment[i] = 0;
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

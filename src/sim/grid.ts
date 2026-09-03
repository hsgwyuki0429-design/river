/**
 * 地形・水のデータモデル。
 *
 * 計算用データ（このクラス）と描画用データ（render/ 以下）は分離する。
 * 配列は SoA (Structure of Arrays) で保持し、GC負荷とキャッシュミスを抑える。
 */

export class TerrainGrid {
  readonly width: number;
  readonly height: number;
  readonly size: number;

  /** 地盤の高さ [m] */
  readonly bedHeight: Float32Array;
  /** これ以上掘れない高さ（岩盤）[m] */
  readonly bedrockHeight: Float32Array;
  /** 水深 [m] */
  readonly waterDepth: Float32Array;
  /** 流速 x [m/s] */
  readonly velocityX: Float32Array;
  /** 流速 y [m/s] */
  readonly velocityY: Float32Array;
  /** 水中に浮遊している砂（高さ換算）[m] */
  readonly suspendedSediment: Float32Array;
  /** 地盤の削れやすさ 0..1 (0 = 岩盤で削れない) */
  readonly erodibility: Float32Array;
  /** 累積の堆積量 [m]（お題判定・表示用） */
  readonly depositedSediment: Float32Array;

  /** 仮想パイプの流量 [m^3/s]（左/右/上/下へ出て行く量、常に >= 0） */
  readonly fluxL: Float32Array;
  readonly fluxR: Float32Array;
  readonly fluxT: Float32Array;
  readonly fluxB: Float32Array;

  /** 直前フレームの侵食量 [m]（表示用に減衰させる） */
  readonly erosionRecent: Float32Array;
  /** 直前フレームの堆積量 [m]（表示用に減衰させる） */
  readonly depositionRecent: Float32Array;

  /** 排水セル（1 なら水を盤面外へ捨てる） */
  readonly drain: Uint8Array;

  // --- 作業用バッファ ---
  readonly scratchDepth: Float32Array;
  readonly scratchSediment: Float32Array;
  readonly scratchDelta: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.size = width * height;
    const n = this.size;
    this.bedHeight = new Float32Array(n);
    this.bedrockHeight = new Float32Array(n);
    this.waterDepth = new Float32Array(n);
    this.velocityX = new Float32Array(n);
    this.velocityY = new Float32Array(n);
    this.suspendedSediment = new Float32Array(n);
    this.erodibility = new Float32Array(n).fill(1);
    this.depositedSediment = new Float32Array(n);
    this.fluxL = new Float32Array(n);
    this.fluxR = new Float32Array(n);
    this.fluxT = new Float32Array(n);
    this.fluxB = new Float32Array(n);
    this.erosionRecent = new Float32Array(n);
    this.depositionRecent = new Float32Array(n);
    this.drain = new Uint8Array(n);
    this.scratchDepth = new Float32Array(n);
    this.scratchSediment = new Float32Array(n);
    this.scratchDelta = new Float32Array(n);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** 水面高 = 地盤高 + 水深 */
  waterSurface(i: number): number {
    return this.bedHeight[i] + this.waterDepth[i];
  }

  /** 全ての水・土砂・流束を消す（地形はそのまま） */
  clearWater(): void {
    this.waterDepth.fill(0);
    this.suspendedSediment.fill(0);
    this.velocityX.fill(0);
    this.velocityY.fill(0);
    this.fluxL.fill(0);
    this.fluxR.fill(0);
    this.fluxT.fill(0);
    this.fluxB.fill(0);
    this.erosionRecent.fill(0);
    this.depositionRecent.fill(0);
  }

  /** 総水量 [m^3] */
  totalWater(cellArea: number): number {
    let s = 0;
    const d = this.waterDepth;
    for (let i = 0; i < this.size; i++) s += d[i];
    return s * cellArea;
  }

  /** 総土砂量（地盤＋浮遊）[m^3] */
  totalSediment(cellArea: number): number {
    let s = 0;
    const b = this.bedHeight;
    const q = this.suspendedSediment;
    for (let i = 0; i < this.size; i++) s += b[i] + q[i];
    return s * cellArea;
  }
}

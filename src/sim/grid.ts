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
  /** 河床近傍を移動中の掃流砂（高さ換算）[m] */
  readonly bedloadSediment: Float32Array;
  /** 地盤の削れやすさ 0..1 (0 = 岩盤で削れない) */
  readonly erodibility: Float32Array;
  /** 累積の堆積量 [m]（お題判定・表示用） */
  readonly depositedSediment: Float32Array;

  /** 仮想パイプの流量 [m^3/s]（左/右/上/下へ出て行く量、常に >= 0） */
  readonly fluxL: Float32Array;
  readonly fluxR: Float32Array;
  readonly fluxT: Float32Array;
  readonly fluxB: Float32Array;
  readonly fluxTL: Float32Array;
  readonly fluxTR: Float32Array;
  readonly fluxBL: Float32Array;
  readonly fluxBR: Float32Array;
  /** L,R,T,B,TL,TR,BL,BR の順。配列自体も一度だけ確保する。 */
  readonly fluxes: readonly Float32Array[];

  /** 平滑化・正規化した流向ベクトル */
  readonly smoothedVelocityX: Float32Array;
  readonly smoothedVelocityY: Float32Array;
  /** 流向 [rad] と符号付き曲率 [1/m] */
  /**
   * 単位化した流向（updateFlowGeometry の平滑化で使い回す作業配列）。
   * 平滑化の積算結果を元の実装とビット単位で一致させるため Float64 で持つ。
   */
  readonly unitVelocityX: Float64Array;
  readonly unitVelocityY: Float64Array;
  readonly curvature: Float32Array;
  /** 曲率に遅れて追従する符号付き二次流 */
  readonly secondaryFlow: Float32Array;
  /** 1=外岸、-1=内岸、0=その他 */
  readonly bankSide: Int8Array;
  /** 河岸侵食・掃流砂移動の直近量 [m] */
  readonly bankErosionRecent: Float32Array;
  readonly bedloadTransportRecent: Float32Array;
  /** 低流速の継続時間 [s] と読み取り専用の三日月湖候補 */
  readonly lowVelocityAge: Float32Array;
  readonly oxbowCandidate: Uint8Array;
  readonly mainChannel: Uint8Array;

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
  readonly scratchDelta2: Float32Array;
  readonly scratchDelta3: Float32Array;
  readonly scratchVisit: Uint8Array;
  readonly scratchQueue: Int32Array;

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
    this.bedloadSediment = new Float32Array(n);
    this.erodibility = new Float32Array(n).fill(1);
    this.depositedSediment = new Float32Array(n);
    this.fluxL = new Float32Array(n);
    this.fluxR = new Float32Array(n);
    this.fluxT = new Float32Array(n);
    this.fluxB = new Float32Array(n);
    this.fluxTL = new Float32Array(n);
    this.fluxTR = new Float32Array(n);
    this.fluxBL = new Float32Array(n);
    this.fluxBR = new Float32Array(n);
    this.fluxes = [
      this.fluxL,
      this.fluxR,
      this.fluxT,
      this.fluxB,
      this.fluxTL,
      this.fluxTR,
      this.fluxBL,
      this.fluxBR,
    ];
    this.smoothedVelocityX = new Float32Array(n);
    this.smoothedVelocityY = new Float32Array(n);
    this.unitVelocityX = new Float64Array(n);
    this.unitVelocityY = new Float64Array(n);
    this.curvature = new Float32Array(n);
    this.secondaryFlow = new Float32Array(n);
    this.bankSide = new Int8Array(n);
    this.bankErosionRecent = new Float32Array(n);
    this.bedloadTransportRecent = new Float32Array(n);
    this.lowVelocityAge = new Float32Array(n);
    this.oxbowCandidate = new Uint8Array(n);
    this.mainChannel = new Uint8Array(n);
    this.erosionRecent = new Float32Array(n);
    this.depositionRecent = new Float32Array(n);
    this.drain = new Uint8Array(n);
    this.scratchDepth = new Float32Array(n);
    this.scratchSediment = new Float32Array(n);
    this.scratchDelta = new Float32Array(n);
    this.scratchDelta2 = new Float32Array(n);
    this.scratchDelta3 = new Float32Array(n);
    this.scratchVisit = new Uint8Array(n);
    this.scratchQueue = new Int32Array(n);
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
    this.bedloadSediment.fill(0);
    this.velocityX.fill(0);
    this.velocityY.fill(0);
    this.fluxL.fill(0);
    this.fluxR.fill(0);
    this.fluxT.fill(0);
    this.fluxB.fill(0);
    this.fluxTL.fill(0);
    this.fluxTR.fill(0);
    this.fluxBL.fill(0);
    this.fluxBR.fill(0);
    this.smoothedVelocityX.fill(0);
    this.smoothedVelocityY.fill(0);
    this.unitVelocityX.fill(0);
    this.unitVelocityY.fill(0);
    this.curvature.fill(0);
    this.secondaryFlow.fill(0);
    this.bankSide.fill(0);
    this.bankErosionRecent.fill(0);
    this.bedloadTransportRecent.fill(0);
    this.lowVelocityAge.fill(0);
    this.oxbowCandidate.fill(0);
    this.mainChannel.fill(0);
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
    const bl = this.bedloadSediment;
    for (let i = 0; i < this.size; i++) s += b[i] + q[i] + bl[i];
    return s * cellArea;
  }
}

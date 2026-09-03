/**
 * シミュレーションの型定義とパラメータ。
 *
 * 単位系は SI に準じる。
 *   長さ  : m   (bedHeight / waterDepth / suspendedSediment はすべて「高さ [m]」)
 *   時間  : s
 *   流量  : m^3/s
 *
 * suspendedSediment は「そのセルの水中に浮遊している砂を、セル底面積で割った高さ [m]」。
 * これにより bedHeight との加減算がそのまま土砂量の保存になる。
 */

/** 物理・数値パラメータ。ステージや端末性能に応じて上書きできる。 */
export interface SimParams {
  // --- 格子と時間 ---
  /** セル1辺の長さ [m] */
  cellSize: number;
  /** 固定時間刻み [s]。描画fpsに依らずこの刻みで積分する */
  fixedDt: number;
  /** 1フレームあたりの最大サブステップ数（高負荷時の保険） */
  maxSubsteps: number;
  /** CFL 安全係数 (0<cfl<=1) */
  cfl: number;

  // --- 水理 (virtual pipe) ---
  gravity: number;
  /**
   * 仮想パイプ断面積の係数。実断面積 = fluxGain * cellSize * hFlow
   * （hFlow は隣接セル間で実際に水がつながっている深さ）
   */
  fluxGain: number;
  /** 仮想パイプの長さ [m]。通常は cellSize */
  pipeLength: number;
  /**
   * Manning の粗度係数 n [s/m^(1/3)]。
   * 摩擦は半陰的に解くため、これが実質的な終端流速 v = d^(2/3) * sqrt(S) / n を決める。
   * 永久振動もこの摩擦で減衰する。
   */
  manningN: number;
  /** フルード数の上限（超臨界流の暴走防止） */
  froudeMax: number;
  /** これ以下の水深は「乾いている」とみなす [m] */
  minDepth: number;
  /** 蒸発速度 [m/s]。MVPでは既定0 */
  evaporation: number;

  // --- 侵食・運搬・堆積 ---
  /** 水の密度 [kg/m^3] */
  density: number;
  /** 限界掃流力 [Pa]。これを超えた分だけ侵食する */
  criticalShear: number;
  /** 侵食係数 [m/(Pa*s)] */
  erosionRate: number;
  /** 1秒あたりの侵食量上限 [m/s]（暴走防止） */
  maxErosionRate: number;
  /** 運搬能力係数 */
  capacityRate: number;
  /** 運搬能力の流速指数 p */
  speedExponent: number;
  /** 運搬能力の勾配指数 q */
  slopeExponent: number;
  /** 勾配の下限（0除算と過小評価の回避） */
  minSlope: number;
  /** 濃度上限（浮遊土砂高 / 水深）の最大値 */
  maxConcentration: number;
  /** 堆積係数 [1/s] */
  depositionRate: number;
  /** 乾きかけのセルで浮遊土砂を落とす速度 [1/s] */
  dryDepositionRate: number;
  /** 地形変化の時間スケール倍率（水の速度と地形変化速度の分離） */
  morphologicalTimeScale: number;

  // --- 安息角による崩落 ---
  /** 乾いた砂の安息角の正接 (tanθ) */
  reposeTanDry: number;
  /** 水を含んだ砂の安息角の正接 (tanθ)。dry より小さい＝崩れやすい */
  reposeTanWet: number;
  /** 崩落速度 [1/s] */
  slippageRate: number;

  /** 盤面外へ水を出す境界 */
  openBoundary: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

export const DEFAULT_PARAMS: SimParams = {
  cellSize: 1,
  fixedDt: 1 / 60,
  maxSubsteps: 4,
  cfl: 0.5,

  gravity: 9.81,
  fluxGain: 1,
  pipeLength: 1,
  manningN: 0.03,
  froudeMax: 2.5,
  minDepth: 1e-4,
  evaporation: 0,

  density: 1000,
  criticalShear: 12,
  erosionRate: 2.2e-5,
  maxErosionRate: 0.06,
  capacityRate: 0.55,
  speedExponent: 1.3,
  slopeExponent: 0.5,
  minSlope: 0.008,
  maxConcentration: 0.35,
  depositionRate: 3.2,
  dryDepositionRate: 8,
  morphologicalTimeScale: 8,

  reposeTanDry: 0.7,
  reposeTanWet: 0.42,
  slippageRate: 3.5,

  openBoundary: { left: false, right: false, top: false, bottom: false },
};

export function cloneParams(p: SimParams): SimParams {
  return { ...p, openBoundary: { ...p.openBoundary } };
}

/** 水源。rate は「スライダー最大時」の流量 [m^3/s] */
export interface WaterSource {
  id: string;
  /** セル座標 */
  x: number;
  y: number;
  /** 影響半径 [セル] */
  radius: number;
  /** 最大流量 [m^3/s] */
  maxRate: number;
}

/** 水・土砂の収支 */
export interface Budget {
  /** 水源から加えた水の体積 [m^3] */
  waterAdded: number;
  /** 盤面外・排水口から出た水の体積 [m^3] */
  waterOut: number;
  /** 蒸発した水の体積 [m^3] */
  waterEvaporated: number;
  /** 初期の水量 [m^3] */
  waterInitial: number;

  /** プレイヤーが盛った砂の体積 [m^3] */
  sandAdded: number;
  /** プレイヤーが削った砂の体積 [m^3] */
  sandRemoved: number;
  /** 盤面外へ流出した土砂の体積 [m^3] */
  sedimentOut: number;
  /** 初期の土砂量（地盤＋浮遊）[m^3] */
  sedimentInitial: number;

  /** 数値破綻の検出回数 */
  numericFaults: number;
}

export function createBudget(): Budget {
  return {
    waterAdded: 0,
    waterOut: 0,
    waterEvaporated: 0,
    waterInitial: 0,
    sandAdded: 0,
    sandRemoved: 0,
    sedimentOut: 0,
    sedimentInitial: 0,
    numericFaults: 0,
  };
}

/** 1ステップの統計（デバッグ表示・お題判定に使う） */
export interface StepStats {
  /** 盤面内の総水量 [m^3] */
  waterVolume: number;
  /** 盤面内の総土砂量（地盤＋浮遊）[m^3] */
  sedimentVolume: number;
  /** 水収支の誤差 [m^3] */
  waterError: number;
  /** 土砂収支の誤差 [m^3] */
  sedimentError: number;
  /** 濡れているセル数 */
  wetCells: number;
  /** 最大水深 [m] */
  maxDepth: number;
  /** 最大流速 [m/s] */
  maxSpeed: number;
  /** このフレームで侵食された体積 [m^3] */
  erodedVolume: number;
  /** このフレームで堆積した体積 [m^3] */
  depositedVolume: number;
  /** 実行したサブステップ数 */
  substeps: number;
}

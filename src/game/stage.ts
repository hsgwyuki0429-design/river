/**
 * ステージ定義の型。
 *
 * 成功条件・失敗条件・使用可能な砂量・目標時間はすべてデータとして
 * ここに集約し、判定ロジック（objectives.ts）から参照する。
 * 条件式をゲームコードの中に直接書かないこと。
 */

import type { TerrainOp } from '../sim/terrain.ts';
import type { SimParams } from '../sim/types.ts';

/** 正規化矩形 (0..1) */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ZoneKind =
  /** 水を届ける目標区域 */
  | 'goal'
  /** 浸水させてはいけない区域 */
  | 'protected'
  /** 土砂を堆積させる目標区域 */
  | 'deposit'
  /** 盤面外へ水を捨てる出口 */
  | 'drain'
  /** 既存の水域（接続の起点／終点） */
  | 'water';

export interface Zone {
  id: string;
  kind: ZoneKind;
  label: string;
  rect: NormRect;
}

/** 成功／失敗を判定する条件。すべてデータで表現する */
export type Condition =
  /** 区域に一定以上の水が溜まる */
  | {
      type: 'waterInZone';
      zone: string;
      /** 判定する最小水深 [m] */
      minDepth: number;
      /** 条件を満たすべき区域内セルの割合 0..1 */
      minCoverage: number;
      /** 継続して満たす秒数 */
      sustain: number;
      label: string;
    }
  /** 2つの区域が水でつながる */
  | {
      type: 'connectZones';
      from: string;
      to: string;
      minDepth: number;
      sustain: number;
      label: string;
    }
  /** 区域に指定体積以上の土砂が堆積する */
  | { type: 'sedimentInZone'; zone: string; volume: number; label: string }
  /** 指定体積以上の水を出口から排水する */
  | { type: 'drainedWater'; volume: number; label: string }
  /** 盤面外へ流出した土砂が上限を超える（失敗条件） */
  | { type: 'sedimentLostLimit'; volume: number; label: string }
  /** 区域への浸水量が上限を超える（失敗条件） */
  | { type: 'floodLimit'; zone: string; maxVolume: number; label: string }
  /** 使用した砂の量が上限を超える（失敗条件） */
  | { type: 'sandLimit'; volume: number; label: string }
  /** 制限時間を超える（失敗条件） */
  | { type: 'timeLimit'; seconds: number; label: string };

export interface StageSource {
  id: string;
  /** 正規化座標 */
  x: number;
  y: number;
  /** 半径 [正規化。盤面の短辺基準] */
  radius: number;
  /** スライダー最大時の流量 [m^3/s] */
  maxRate: number;
}

export interface StageDef {
  id: string;
  name: string;
  subtitle: string;
  /** 攻略のヒント */
  hint: string;
  terrain: TerrainOp[];
  sources: StageSource[];
  zones: Zone[];
  openBoundary: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  /** 使用できる砂の総量（盛った量＋削った量）[m^3]。null で無制限 */
  sandBudget: number | null;
  /** 目標時間 [s]。速いほど高評価 */
  targetTime: number;
  /** 制限時間 [s]。null で無制限 */
  timeLimit: number | null;
  /** 開始時の水量スライダー 0..1 */
  initialInflow: number;
  /** スライダーの下限（上流から流れ続ける水） */
  minInflow: number;
  success: Condition[];
  failure: Condition[];
  /** ステージ固有の物理パラメータ上書き */
  params?: Partial<SimParams>;
  /** 保存・表示用の地形プリセット識別子 */
  presetId?: string;
  /** 再現可能な地形乱数シード */
  seed?: number;
  /** 通常品質に対する縦セル数倍率 */
  gridHeightMultiplier?: number;
  /** 循環タンクへ与える有限な初期水量 [m^3] */
  circulationInitialWater?: number;
}

/** 1つの条件の評価結果 */
export interface ConditionState {
  label: string;
  /** 0..1 の進捗 */
  progress: number;
  satisfied: boolean;
  /** 画面に出す現在値の文字列 */
  detail: string;
}

/** ステージ進行中の各種計測値（評価項目） */
export interface StageMetrics {
  /** 経過時間 [s] */
  elapsed: number;
  /** 目標達成度 0..1 */
  achievement: number;
  /** 浸水禁止区域への累積流入量 [m^3] */
  floodVolume: number;
  /** 使用した砂の量（盛り＋削り）[m^3] */
  sandUsed: number;
  /** 盤面外へ流失した水量 [m^3] */
  waterLost: number;
  /** 指定区域への堆積量 [m^3] */
  depositVolume: number;
  /** 排水口から排水した水量 [m^3] */
  drainedVolume: number;
  /** 盤面外へ流出した土砂の量 [m^3] */
  sedimentLost: number;
}

export interface StageResult {
  cleared: boolean;
  failed: boolean;
  failReason: string;
  /** 0..3 の星 */
  stars: number;
  metrics: StageMetrics;
}

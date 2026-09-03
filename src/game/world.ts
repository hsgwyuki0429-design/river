/**
 * ステージ定義 → シミュレーション実体 の組み立て。
 *
 * 正規化座標で書かれたステージデータを、実際の格子解像度に展開する。
 */

import { Simulation } from '../sim/simulation.ts';
import { applyTerrainOps, type TerrainOp } from '../sim/terrain.ts';
import type { SimParams } from '../sim/types.ts';
import { ObjectiveTracker } from './objectives.ts';
import type { StageDef } from './stage.ts';

export interface WorldOptions {
  width: number;
  height: number;
  cellSize: number;
  params?: Partial<SimParams>;
}

export interface World {
  sim: Simulation;
  stage: StageDef | null;
  tracker: ObjectiveTracker | null;
}

/** 自由モードの初期地形 */
export const SANDBOX_TERRAIN: TerrainOp[] = [
  { type: 'slope', high: 5.0, low: 1.2, dir: 'down' },
  { type: 'noise', amplitude: 0.22, scale: 3.5, seed: 8801 },
  { type: 'hill', x: 0.22, y: 0.3, radius: 0.18, height: 1.1 },
  { type: 'hill', x: 0.78, y: 0.42, radius: 0.2, height: 1.3 },
  { type: 'carve', x: 0.2, y: 0.74, w: 0.6, h: 0.2, height: 1.35, blend: 0.05 },
];

export const SANDBOX_STAGE: StageDef = {
  id: 'sandbox',
  name: '自由モード',
  subtitle: '有限の水と砂が上下に循環する箱庭',
  hint: '盤面は上下につながっている。下端から出た水と砂は、同じ位置の上端へ戻ってくる。',
  terrain: SANDBOX_TERRAIN,
  sources: [{ id: 'pump', x: 0.5, y: 0.04, radius: 0.045, maxRate: 2.2 }],
  zones: [],
  // 下端は circulationEnabled が開けるので、ここでは閉じておく
  openBoundary: { left: false, right: false, top: false, bottom: false },
  sandBudget: null,
  targetTime: 0,
  timeLimit: null,
  initialInflow: 0.5,
  minInflow: 0,
  success: [],
  failure: [],
  // 有限の水が盤面を上下に循環し続ける（下端を出た水は同じX列の上端へ戻る）
  circulationInitialWater: 90,
  params: {
    circulationEnabled: true,
    // 曲率・二次流・河岸侵食・内岸砂州・掃流砂を有効にして、
    // 川幅方向（横方向）の侵食と堆積による流路の移り変わりを観察できるようにする
    meanderDynamics: true,
    criticalShear: 8,
    erosionRate: 2.8e-5,
    // 蛇行観察プリセットより横方向を強めてある。実測で流路中心線の移動量が
    // 60秒あたり 平均2.6→3.7セル、最大16→27セルになる設定
    bankErosionRate: 3.0e-5,
    curvatureErosionGain: 3.5,
    pointBarDepositionGain: 1.1,
  },
};

/**
 * 蛇行の成長と河道切断を、待たずに観察するためのプリセット。
 *
 * 直線から蛇行が自然発生するのを待つと川の時間で何十分もかかるため、
 * 初期形状としてあらかじめ強く蛇行した流路を刻み、そのうち1つを
 * 「首の細いループ」にしてある。切断が起きやすい状態から始める。
 *
 * 循環する水を絞ってあるのは、水が多いと氾濫原へ広がって流路が
 * まとまらず、曲がりも切断も起きなくなるため（実測で確認）。
 *
 * 実測の目安（川の時間）:
 *   30秒  蛇行度 1.3
 *   90秒  蛇行度 1.7 まで急成長
 *   150〜420秒  三日月湖がたびたび現れる
 *   330秒  蛇行度 1.8 前後で頭打ち
 */
export const MEANDER_SANDBOX_STAGE: StageDef = {
  id: 'meander-sandbox',
  name: '蛇行観察',
  subtitle: '強く曲がった流路から、切断と三日月湖まで',
  hint: '最初から大きく蛇行している。90秒ほどで曲がりが育ち、そのあと首の細い所が切れて三日月湖が残る。',
  terrain: [
    { type: 'slope', high: 3.2, low: 2.2, dir: 'down' },
    { type: 'noise', amplitude: 0.035, scale: 7, seed: 76123, octaves: 3 },
    {
      type: 'channel',
      points: [
        [0.5, 0],
        [0.34, 0.08],
        [0.68, 0.18],
        [0.3, 0.28],
        // ここが首の細いループ。入口と出口が y 方向に近い
        [0.46, 0.36],
        [0.84, 0.37],
        [0.9, 0.4],
        [0.84, 0.43],
        [0.46, 0.44],
        [0.3, 0.52],
        [0.7, 0.62],
        [0.32, 0.72],
        [0.66, 0.82],
        [0.5, 1],
      ],
      width: 0.045,
      depth: 0.36,
    },
    { type: 'erodibility', x: 0, y: 0, w: 1, h: 1, value: 1 },
  ],
  sources: [{ id: 'pump', x: 0.5, y: 0.01, radius: 0.055, maxRate: 0.9 }],
  zones: [],
  openBoundary: { left: false, right: false, top: false, bottom: false },
  sandBudget: null,
  targetTime: 0,
  timeLimit: null,
  initialInflow: 0.55,
  minInflow: 0,
  success: [],
  failure: [],
  presetId: 'meander-v2',
  seed: 76123,
  gridHeightMultiplier: 2,
  circulationInitialWater: 20,
  params: {
    meanderDynamics: true,
    circulationEnabled: true,
    morphologicalTimeScale: 30,
    criticalShear: 8,
    erosionRate: 2.8e-5,
    bankErosionRate: 3.0e-5,
    curvatureErosionGain: 3.5,
    pointBarDepositionGain: 1.1,
  },
};

export function createWorld(stage: StageDef, opts: WorldOptions): World {
  const sim = new Simulation(opts.width, opts.height, {
    cellSize: opts.cellSize,
    pipeLength: opts.cellSize,
    diagonalFlowEnabled: stage.id === 'sandbox' || stage.id === 'meander-sandbox',
    openBoundary: { ...stage.openBoundary },
    ...opts.params,
    ...stage.params,
  });

  applyTerrainOps(sim.grid, stage.terrain);

  sim.sources = stage.sources.map((s) => ({
    id: s.id,
    x: s.x * opts.width,
    y: s.y * opts.height,
    radius: Math.max(1.5, s.radius * opts.width),
    maxRate: s.maxRate,
  }));
  sim.inflowScale = stage.initialInflow;
  sim.presetId = stage.presetId ?? stage.id;
  sim.randomSeed = stage.seed ?? 0;
  if (stage.circulationInitialWater !== undefined) {
    sim.seedCirculation(stage.circulationInitialWater);
  }
  sim.resetBudget();

  const tracker = stage.success.length > 0 ? new ObjectiveTracker(stage, sim) : null;
  return { sim, stage: stage.id === SANDBOX_STAGE.id ? null : stage, tracker };
}

/** 地形と水を初期状態へ戻す */
export function resetWorld(world: World, stage: StageDef): void {
  const { sim } = world;
  sim.grid.clearWater();
  sim.grid.bedHeight.fill(0);
  sim.grid.bedrockHeight.fill(0);
  sim.grid.erodibility.fill(1);
  sim.grid.depositedSediment.fill(0);
  sim.grid.drain.fill(0);
  applyTerrainOps(sim.grid, stage.terrain);
  sim.seedCirculation(stage.circulationInitialWater ?? 0);
  sim.inflowScale = stage.initialInflow;
  sim.resetBudget();
  world.tracker?.reset(sim);
}

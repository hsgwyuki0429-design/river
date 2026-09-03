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
  subtitle: '制限なしの箱庭',
  hint: '砂を盛る・削る、水量を変える。地形が水を変え、水が地形を変える。',
  terrain: SANDBOX_TERRAIN,
  sources: [{ id: 'spring', x: 0.5, y: 0.05, radius: 0.04, maxRate: 1.6 }],
  zones: [],
  openBoundary: { left: false, right: false, top: false, bottom: true },
  sandBudget: null,
  targetTime: 0,
  timeLimit: null,
  initialInflow: 0.35,
  minInflow: 0,
  success: [],
  failure: [],
};

export function createWorld(stage: StageDef, opts: WorldOptions): World {
  const sim = new Simulation(opts.width, opts.height, {
    cellSize: opts.cellSize,
    pipeLength: opts.cellSize,
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
  sim.inflowScale = stage.initialInflow;
  sim.resetBudget();
  world.tracker?.reset(sim);
}

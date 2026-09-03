import { describe, expect, it } from 'vitest';
import { ObjectiveTracker } from '../src/game/objectives.ts';
import { createWorld } from '../src/game/world.ts';
import type { StageDef } from '../src/game/stage.ts';

const base: StageDef = {
  id: 'test',
  name: 'テスト',
  subtitle: '',
  hint: '',
  terrain: [{ type: 'flat', height: 1 }],
  sources: [],
  zones: [
    { id: 'goal', kind: 'goal', label: 'ゴール', rect: { x: 0.0, y: 0.0, w: 0.5, h: 0.5 } },
    { id: 'far', kind: 'water', label: '対岸', rect: { x: 0.6, y: 0.6, w: 0.4, h: 0.4 } },
    { id: 'safe', kind: 'protected', label: '保護', rect: { x: 0.6, y: 0.0, w: 0.4, h: 0.3 } },
    { id: 'dep', kind: 'deposit', label: '堆積', rect: { x: 0.0, y: 0.6, w: 0.4, h: 0.4 } },
  ],
  openBoundary: { left: false, right: false, top: false, bottom: false },
  sandBudget: 10,
  targetTime: 30,
  timeLimit: 60,
  initialInflow: 0,
  minInflow: 0,
  success: [],
  failure: [],
};

function makeWorld(overrides: Partial<StageDef>) {
  const stage: StageDef = { ...base, ...overrides };
  const world = createWorld(stage, { width: 20, height: 20, cellSize: 0.5 });
  const tracker = new ObjectiveTracker(stage, world.sim);
  return { stage, sim: world.sim, tracker };
}

describe('お題の判定', () => {
  it('waterInZone: 指定区域が指定水深で覆われ、継続すると成功', () => {
    const { sim, tracker } = makeWorld({
      success: [
        {
          type: 'waterInZone',
          zone: 'goal',
          minDepth: 0.1,
          minCoverage: 0.8,
          sustain: 2,
          label: 'ゴールを満たす',
        },
      ],
    });
    expect(tracker.update(sim, 0.5).cleared).toBe(false);

    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) sim.grid.waterDepth[sim.grid.index(x, y)] = 0.3;
    }
    // 継続時間を満たすまでは達成にならない
    expect(tracker.update(sim, 0.5).cleared).toBe(false);
    expect(tracker.update(sim, 0.5).cleared).toBe(false);
    expect(tracker.update(sim, 0.5).cleared).toBe(false);
    expect(tracker.update(sim, 0.5).cleared).toBe(true);
  });

  it('connectZones: 濡れたセルがつながって初めて成功する', () => {
    const { sim, tracker } = makeWorld({
      success: [
        {
          type: 'connectZones',
          from: 'goal',
          to: 'far',
          minDepth: 0.05,
          sustain: 0,
          label: 'つなぐ',
        },
      ],
    });
    const g = sim.grid;
    g.waterDepth[g.index(2, 2)] = 0.3;
    g.waterDepth[g.index(17, 17)] = 0.3;
    expect(tracker.update(sim, 0.5).cleared).toBe(false);

    // 対角に水路を通す
    for (let k = 2; k <= 17; k++) {
      g.waterDepth[g.index(k, k)] = 0.3;
      g.waterDepth[g.index(k, k + 1 <= 19 ? k + 1 : 19)] = 0.3;
    }
    expect(tracker.update(sim, 0.5).cleared).toBe(true);
  });

  it('floodLimit: 保護区域への浸水量が上限を超えると失敗する', () => {
    const { sim, tracker } = makeWorld({
      success: [{ type: 'drainedWater', volume: 1000, label: '排水' }],
      failure: [{ type: 'floodLimit', zone: 'safe', maxVolume: 0.2, label: '浸水した' }],
    });
    const g = sim.grid;
    for (let y = 0; y < 6; y++) {
      for (let x = 12; x < 20; x++) g.waterDepth[g.index(x, y)] = 0.5;
    }
    tracker.accumulateFlood(sim, 1 / 60);
    const r = tracker.update(sim, 0.5);
    expect(r.failed).toBe(true);
    expect(r.failReason).toContain('浸水');
    // 水が引いてもピーク浸水量は記録され続ける
    g.waterDepth.fill(0);
    tracker.accumulateFlood(sim, 1 / 60);
    expect(tracker.metrics.floodVolume).toBeGreaterThan(0.2);
  });

  it('sedimentInZone: 指定区域の地盤が上がった分が堆積量になる', () => {
    const { sim, tracker } = makeWorld({
      success: [{ type: 'sedimentInZone', zone: 'dep', volume: 0.5, label: '堆積させる' }],
    });
    expect(tracker.update(sim, 0.5).cleared).toBe(false);
    const g = sim.grid;
    for (let y = 12; y < 20; y++) {
      for (let x = 0; x < 8; x++) g.bedHeight[g.index(x, y)] += 0.05;
    }
    const r = tracker.update(sim, 0.5);
    // 64セル × 0.05m × 0.25m² = 0.8 m³
    expect(tracker.metrics.depositVolume).toBeCloseTo(0.8, 2);
    expect(r.cleared).toBe(true);
  });

  it('timeLimit: 制限時間を超えると失敗する', () => {
    const { sim, tracker } = makeWorld({
      success: [{ type: 'drainedWater', volume: 1000, label: '排水' }],
      failure: [{ type: 'timeLimit', seconds: 1, label: '時間切れ' }],
    });
    for (let i = 0; i < 70; i++) sim.step(1 / 60);
    const r = tracker.update(sim, 0.5);
    expect(r.failed).toBe(true);
    expect(r.failReason).toBe('時間切れ');
  });

  it('評価項目（使用した砂・流失した水量）が集計される', () => {
    const { sim, tracker } = makeWorld({
      success: [{ type: 'drainedWater', volume: 1000, label: '排水' }],
    });
    sim.modifyTerrain(10, 10, 3, 0.4);
    sim.modifyTerrain(4, 4, 3, -0.2);
    tracker.update(sim, 0.5);
    expect(tracker.metrics.sandUsed).toBeCloseTo(
      sim.budget.sandAdded + sim.budget.sandRemoved,
      6,
    );
    expect(tracker.metrics.sandUsed).toBeGreaterThan(0);
    expect(tracker.metrics.waterLost).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation.ts';
import { deserialize, serialize } from '../src/game/saveLoad.ts';

function build(w: number, h: number): Simulation {
  const sim = new Simulation(w, h, { cellSize: 0.5, pipeLength: 0.5 });
  const g = sim.grid;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = g.index(x, y);
      g.bedHeight[i] = 2 + Math.sin(x * 0.3) * 0.5 + (y / h) * 1.5;
      if (y > h * 0.6) g.waterDepth[i] = 0.2;
      g.suspendedSediment[i] = 0.01;
    }
  }
  sim.sources = [{ id: 's', x: w * 0.5, y: 2, radius: 3, maxRate: 1.2 }];
  sim.inflowScale = 0.7;
  sim.resetBudget();
  return sim;
}

describe('保存・読み込み', () => {
  it('同じ解像度なら地形・水・浮遊土砂がそのまま復元される', () => {
    const a = build(32, 48);
    const data = serialize(a);
    const b = new Simulation(32, 48, { cellSize: 0.5, pipeLength: 0.5 });
    b.sources = [{ id: 's', x: 0, y: 0, radius: 3, maxRate: 1.2 }];
    deserialize(b, data);

    for (let i = 0; i < a.grid.size; i++) {
      expect(b.grid.bedHeight[i]).toBeCloseTo(a.grid.bedHeight[i], 5);
      expect(b.grid.waterDepth[i]).toBeCloseTo(a.grid.waterDepth[i], 5);
      expect(b.grid.suspendedSediment[i]).toBeCloseTo(a.grid.suspendedSediment[i], 5);
    }
    expect(b.inflowScale).toBeCloseTo(0.7, 5);
    expect(b.sources[0].x).toBeCloseTo(16, 5);
  });

  it('解像度が違っても補間して読み込め、破綻しない', () => {
    const a = build(32, 48);
    const data = serialize(a);
    const b = new Simulation(48, 72, { cellSize: 0.5, pipeLength: 0.5 });
    b.sources = [{ id: 's', x: 0, y: 0, radius: 3, maxRate: 1.2 }];
    deserialize(b, data);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < b.grid.size; i++) {
      expect(Number.isFinite(b.grid.bedHeight[i])).toBe(true);
      expect(b.grid.waterDepth[i]).toBeGreaterThanOrEqual(0);
      min = Math.min(min, b.grid.bedHeight[i]);
      max = Math.max(max, b.grid.bedHeight[i]);
    }
    // 元の地形と同じ高さの範囲に収まる
    expect(min).toBeGreaterThan(0.5);
    expect(max).toBeLessThan(5);

    // 読み込み後もシミュレーションが破綻しない
    for (let i = 0; i < 300; i++) b.step(1 / 60);
    expect(b.budget.numericFaults).toBe(0);
    expect(b.budgetWithinTolerance(1e-4)).toBe(true);
  });

  it('読み込み後は収支の基準がリセットされる', () => {
    const a = build(24, 24);
    const data = serialize(a);
    const b = new Simulation(24, 24, { cellSize: 0.5, pipeLength: 0.5 });
    deserialize(b, data);
    expect(b.budget.waterAdded).toBe(0);
    expect(b.budget.waterInitial).toBeCloseTo(b.stats.waterVolume, 5);
    expect(b.stats.waterError).toBeCloseTo(0, 6);
  });

  it('v3はX列別循環・掃流砂・二次流・パラメータ・プリセットとシードを復元する', () => {
    const a = build(24, 36);
    a.params.circulationEnabled = true;
    a.params.meanderDynamics = true;
    a.grid.bedloadSediment[17] = 0.03;
    a.grid.secondaryFlow[17] = -0.2;
    a.grid.lowVelocityAge[17] = 4;
    a.presetId = 'meander-v1';
    a.randomSeed = 76123;
    a.seedCirculation(7, 0.4, 0.2);
    a.resetBudget();
    const data = serialize(a);
    expect(data.version).toBe(3);

    const b = new Simulation(24, 36, { cellSize: 0.5, pipeLength: 0.5 });
    b.sources = [{ id: 's', x: 0, y: 0, radius: 3, maxRate: 1.2 }];
    deserialize(b, data);
    expect(b.params.circulationEnabled).toBe(true);
    expect(b.params.meanderDynamics).toBe(true);
    expect(b.grid.bedloadSediment[17]).toBeCloseTo(0.03, 6);
    expect(b.grid.secondaryFlow[17]).toBeCloseTo(-0.2, 6);
    expect(b.grid.lowVelocityAge[17]).toBeCloseTo(4, 6);
    expect(b.circulation.water).toBeCloseTo(7, 6);
    expect(b.circulation.suspendedSediment).toBeCloseTo(0.4, 6);
    expect(b.circulation.bedloadSediment).toBeCloseTo(0.2, 6);
    expect(Array.from(b.circulationWaterByColumn)).toEqual(Array.from(a.circulationWaterByColumn));
    expect(Array.from(b.circulationSuspendedSedimentByColumn)).toEqual(
      Array.from(a.circulationSuspendedSedimentByColumn),
    );
    expect(Array.from(b.circulationBedloadSedimentByColumn)).toEqual(
      Array.from(a.circulationBedloadSedimentByColumn),
    );
    expect(b.presetId).toBe('meander-v1');
    expect(b.randomSeed).toBe(76123);
    expect(b.budgetWithinTolerance(1e-4)).toBe(true);
  });
});

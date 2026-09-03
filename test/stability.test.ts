import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/sim/rng.ts';
import { CELL_SIZE, QUALITY_PRESETS } from '../src/game/session.ts';
import { createWorld, MEANDER_SANDBOX_STAGE, SANDBOX_STAGE } from '../src/game/world.ts';
import { STAGES } from '../src/game/stages.ts';

/**
 * プレイヤーが乱暴に操作し続けても数値が破綻しないことを確認する。
 * 乱数はシード固定なので、失敗したら同じ条件で再現できる。
 */
describe('長時間の安定性', () => {
  it('循環・曲率・掃流砂を有効にした150秒ランダム操作でも保存則を保つ', () => {
    const world = createWorld(MEANDER_SANDBOX_STAGE, {
      width: 32,
      height: 96,
      cellSize: CELL_SIZE,
      params: { maxSubsteps: 2 },
    });
    const sim = world.sim;
    const g = sim.grid;
    const rng = makeRng(76123);
    const initialWater = sim.stats.waterVolume + sim.circulation.water;
    for (let step = 0; step < 150 * 60; step++) {
      if (step % 30 === 0) sim.inflowScale = rng() < 0.15 ? 0 : rng();
      if (step % 12 === 0) {
        sim.modifyTerrain(rng() * g.width, rng() * g.height, 1.5 + rng() * 2, (rng() - 0.5) * 0.25);
      }
      sim.step(1 / 60);
    }
    for (let i = 0; i < g.size; i++) {
      expect(Number.isFinite(g.curvature[i])).toBe(true);
      expect(Number.isFinite(g.secondaryFlow[i])).toBe(true);
      expect(g.bedloadSediment[i]).toBeGreaterThanOrEqual(0);
      expect(g.bedHeight[i]).toBeGreaterThanOrEqual(g.bedrockHeight[i] - 1e-4);
    }
    const finalWater = sim.stats.waterVolume + sim.circulation.water;
    expect(Math.abs(finalWater - initialWater) / Math.max(1, initialWater)).toBeLessThan(1e-4);
    expect(sim.budget.numericFaults).toBe(0);
    expect(sim.budgetWithinTolerance(1e-4)).toBe(true);
  }, 300000);

  it('ランダムな地形編集と水量変更を続けても破綻しない', () => {
    const q = QUALITY_PRESETS[2];
    const world = createWorld(SANDBOX_STAGE, {
      width: q.width,
      height: q.height,
      cellSize: CELL_SIZE,
      params: { maxSubsteps: q.maxSubsteps },
    });
    const sim = world.sim;
    const g = sim.grid;
    const rng = makeRng(20260903);

    const dt = 1 / 60;
    const seconds = 150;
    for (let step = 0; step < seconds / dt; step++) {
      // 0.5秒ごとに水量を変える（急な増水・減水を含む）
      if (step % 30 === 0) {
        sim.inflowScale = rng() < 0.25 ? 0 : rng();
      }
      // 頻繁に砂を盛る／削る
      if (step % 6 === 0) {
        const x = rng() * g.width;
        const y = rng() * g.height;
        const radius = 2 + rng() * 4;
        const amount = (rng() - 0.45) * 1.4;
        sim.modifyTerrain(x, y, radius, amount);
      }
      // まれに水源を動かす
      if (step % 900 === 0 && sim.sources[0]) {
        sim.sources[0].x = rng() * g.width;
        sim.sources[0].y = rng() * (g.height * 0.4);
      }
      sim.step(dt);
    }

    for (let i = 0; i < g.size; i++) {
      expect(Number.isFinite(g.bedHeight[i])).toBe(true);
      expect(Number.isFinite(g.velocityX[i])).toBe(true);
      expect(Number.isFinite(g.velocityY[i])).toBe(true);
      expect(g.waterDepth[i]).toBeGreaterThanOrEqual(0);
      expect(g.suspendedSediment[i]).toBeGreaterThanOrEqual(0);
      expect(g.bedHeight[i]).toBeGreaterThanOrEqual(g.bedrockHeight[i] - 1e-4);
    }
    expect(sim.budget.numericFaults).toBe(0);
    expect(sim.validate().faults).toBe(0);
    expect(sim.budgetWithinTolerance(1e-4)).toBe(true);
    // 流速が発散していない
    expect(sim.stats.maxSpeed).toBeLessThan(20);
  }, 300000);

  it('すべてのステージを最大水量で長時間流し続けても破綻しない', () => {
    for (const stage of STAGES) {
      const world = createWorld(stage, { width: 80, height: 120, cellSize: CELL_SIZE });
      const sim = world.sim;
      sim.inflowScale = 1;
      for (let i = 0; i < 120 * 60; i++) sim.step(1 / 60);
      const g = sim.grid;
      for (let i = 0; i < g.size; i++) {
        if (!Number.isFinite(g.bedHeight[i]) || !(g.waterDepth[i] >= 0)) {
          throw new Error(`ステージ ${stage.id} のセル ${i} が破綻`);
        }
      }
      expect(sim.budget.numericFaults, stage.id).toBe(0);
      expect(sim.budgetWithinTolerance(1e-4), stage.id).toBe(true);
      expect(sim.stats.maxSpeed, stage.id).toBeLessThan(20);
    }
  }, 300000);
});

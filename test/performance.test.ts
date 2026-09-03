import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, BASE_TIME_SCALE, CELL_SIZE } from '../src/game/session.ts';
import { createWorld } from '../src/game/world.ts';
import { STAGES } from '../src/game/stages.ts';

/**
 * 端末での 30fps 以上を確保できるかの目安。
 * CI のマシン性能に左右されるので、しきい値はかなり緩めに取り、
 * 実測値をログに出して「大幅に遅くなる変更」を検出できるようにする。
 */
describe('シミュレーション負荷', () => {
  for (const q of QUALITY_PRESETS) {
    it(`${q.label} (${q.width}×${q.height}) の1ステップが十分速い`, () => {
      const stage = STAGES[2];
      const world = createWorld(stage, {
        width: q.width,
        height: q.height,
        cellSize: CELL_SIZE,
        params: { maxSubsteps: q.maxSubsteps },
      });
      world.sim.inflowScale = 1;
      // 水が行き渡った状態で測る
      for (let i = 0; i < 60 * 60; i++) world.sim.step(1 / 60);

      const N = 240;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) world.sim.step(1 / 60);
      const perStep = (performance.now() - t0) / N;

      // 1フレームあたりに必要なステップ数（1倍速）
      const stepsPerFrame = (1 / 60) * BASE_TIME_SCALE * 60;
      const msPerFrame = perStep * stepsPerFrame;
      // eslint-disable-next-line no-console
      console.log(
        `${q.label} ${q.width}×${q.height}: ${perStep.toFixed(3)} ms/step, ` +
          `1倍速で ${msPerFrame.toFixed(2)} ms/frame (濡れ ${world.sim.stats.wetCells} セル)`,
      );

      // 33ms(30fps) の予算のうち、シミュレーションは半分以内に収まること
      expect(msPerFrame).toBeLessThan(16);
      expect(world.sim.budget.numericFaults).toBe(0);
    }, 120000);
  }
});

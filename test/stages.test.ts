import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/game/stages.ts';
import { createWorld, type World } from '../src/game/world.ts';

const W = 96;
const H = 144;
const CS = 0.5;

/** 折れ線に沿って指を滑らせる操作を再現する */
function stroke(
  world: World,
  pts: [number, number][],
  radius: number,
  amount: number,
  steps: number,
): void {
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(t));
    const f = t - i;
    const x = (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f) * W;
    const y = (pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f) * H;
    world.sim.modifyTerrain(x, y, radius, amount);
  }
}

interface PlayResult {
  cleared: boolean;
  failReason: string;
  sandUsed: number;
  elapsed: number;
  stars: number;
}

function play(
  id: string,
  solve: (w: World) => void,
  inflow: (t: number) => number,
): PlayResult {
  const stage = STAGES.find((s) => s.id === id)!;
  const world = createWorld(stage, { width: W, height: H, cellSize: CS });
  const tracker = world.tracker!;
  solve(world);
  const sandUsed = world.sim.budget.sandAdded + world.sim.budget.sandRemoved;
  const limit = stage.timeLimit ?? 240;
  let cleared = false;
  let failReason = '';
  while (world.sim.elapsed < limit && !cleared && !failReason) {
    world.sim.inflowScale = inflow(world.sim.elapsed);
    for (let k = 0; k < 30; k++) {
      world.sim.step(1 / 60);
      tracker.accumulateFlood(world.sim, 1 / 60);
    }
    const r = tracker.update(world.sim, 0.5);
    if (r.cleared) cleared = true;
    else if (r.failed) failReason = r.failReason;
  }
  // 数値破綻がないこと
  const g = world.sim.grid;
  for (let i = 0; i < g.size; i++) {
    if (!Number.isFinite(g.bedHeight[i]) || !(g.waterDepth[i] >= 0)) {
      throw new Error(`ステージ ${id} のセル ${i} が破綻`);
    }
  }
  expect(world.sim.budget.numericFaults).toBe(0);
  return {
    cleared,
    failReason,
    sandUsed,
    elapsed: world.sim.elapsed,
    stars: tracker.result.stars,
  };
}

describe('ステージ定義', () => {
  it('5つのステージがあり、条件がすべてデータとして定義されている', () => {
    expect(STAGES.length).toBeGreaterThanOrEqual(5);
    for (const s of STAGES) {
      expect(s.success.length).toBeGreaterThan(0);
      expect(s.targetTime).toBeGreaterThan(0);
      // 成功条件が参照する区域が存在すること
      for (const c of s.success) {
        if ('zone' in c) expect(s.zones.some((z) => z.id === c.zone)).toBe(true);
        if ('from' in c) {
          expect(s.zones.some((z) => z.id === c.from)).toBe(true);
          expect(s.zones.some((z) => z.id === c.to)).toBe(true);
        }
      }
      for (const c of s.failure) {
        if ('zone' in c) expect(s.zones.some((z) => z.id === c.zone)).toBe(true);
      }
    }
  });
});

describe('ステージ攻略可能性', () => {
  it('1. 尾根と高台を掘るとゴールへ水が届く', () => {
    const r = play(
      'deliver',
      (w) => stroke(w, [[0.5, 0.36], [0.42, 0.45], [0.3, 0.58], [0.22, 0.72], [0.2, 0.8]], 3.0, -0.6, 34),
      () => 1,
    );
    expect(r.cleared).toBe(true);
    expect(r.sandUsed).toBeLessThanOrEqual(65);
  }, 120000);

  it('2. 尾根を広く掘り下げると2つの池がつながる', () => {
    const r = play(
      'connect',
      (w) => stroke(w, [[0.26, 0.27], [0.3, 0.4], [0.36, 0.5], [0.42, 0.58]], 3.0, -0.9, 30),
      () => 1,
    );
    expect(r.cleared).toBe(true);
    expect(r.sandUsed).toBeLessThanOrEqual(80);
  }, 180000);

  it('3. 導流堤を築くと集落を浸水させずに排水できる', () => {
    const r = play(
      'bypass',
      (w) => stroke(w, [[0.29, 0.43], [0.45, 0.35], [0.61, 0.43]], 2.8, 1.0, 26),
      () => 0.8,
    );
    expect(r.cleared).toBe(true);
    expect(r.sandUsed).toBeLessThanOrEqual(68);
  }, 120000);

  it('4. 切り欠きを塞ぐと低地を守れる／放置すると浸水して失敗する', () => {
    const ok = play('levee', (w) => stroke(w, [[0.4, 0.605], [0.47, 0.615]], 2.6, 0.9, 10), () => 1);
    expect(ok.cleared).toBe(true);
    expect(ok.sandUsed).toBeLessThanOrEqual(30);

    const ng = play('levee', () => {}, () => 1);
    expect(ng.cleared).toBe(false);
    expect(ng.failReason).toContain('浸水');
  }, 180000);

  it('5. 水量を上げれば土砂が指定区域に堆積する／弱いままだと流出して失敗する', () => {
    const ok = play('delta', () => {}, () => 1);
    expect(ok.cleared).toBe(true);

    const ng = play('delta', () => {}, () => 0.3);
    expect(ng.cleared).toBe(false);
    expect(ng.failReason).toContain('流しすぎ');
  }, 240000);
});

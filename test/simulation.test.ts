import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation.ts';
import { DEFAULT_PARAMS } from '../src/sim/types.ts';

function run(sim: Simulation, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.step(dt);
}

/** NaN・負の水深・Infinity が発生していないこと */
function assertSane(sim: Simulation): void {
  const g = sim.grid;
  for (let i = 0; i < g.size; i++) {
    if (
      !Number.isFinite(g.bedHeight[i]) ||
      !Number.isFinite(g.waterDepth[i]) ||
      !Number.isFinite(g.suspendedSediment[i]) ||
      !Number.isFinite(g.velocityX[i]) ||
      !Number.isFinite(g.velocityY[i]) ||
      g.waterDepth[i] < 0 ||
      g.suspendedSediment[i] < 0
    ) {
      throw new Error(
        `セル ${i} が破綻: bed=${g.bedHeight[i]} depth=${g.waterDepth[i]} sed=${g.suspendedSediment[i]}`,
      );
    }
  }
  expect(sim.budget.numericFaults).toBe(0);
}

/** 一様な斜面をつくる（y が増えるほど低い） */
function makeSlope(sim: Simulation, high: number, low: number, flatFrom = 1): void {
  const g = sim.grid;
  for (let y = 0; y < g.height; y++) {
    const t = Math.min(1, y / (g.height - 1) / flatFrom);
    for (let x = 0; x < g.width; x++) g.bedHeight[g.index(x, y)] = high + (low - high) * t;
  }
}

describe('1. 水平な密閉地形', () => {
  it('水が勝手に増減せず、水面がほぼ水平に落ち着く', () => {
    const sim = new Simulation(24, 24, { morphologicalTimeScale: 0 });
    const g = sim.grid;
    g.bedHeight.fill(1);
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) g.waterDepth[g.index(x, y)] = 0.5;
    }
    sim.resetBudget();
    const initial = sim.stats.waterVolume;

    run(sim, 40);
    assertSane(sim);

    // 密閉なので水量は完全に保存される
    expect(sim.stats.waterVolume).toBeCloseTo(initial, 4);
    expect(sim.budget.waterOut).toBe(0);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < g.size; i++) {
      const s = g.waterSurface(i);
      if (s < min) min = s;
      if (s > max) max = s;
    }
    // 初期の高低差 0.5m が 2cm 未満まで均される
    expect(max - min).toBeLessThan(0.02);
  });
});

describe('2. 一方向の斜面', () => {
  it('水は下り方向へ流れ、上り方向へ流れ続けない', () => {
    const sim = new Simulation(16, 40, {
      morphologicalTimeScale: 0,
      openBoundary: { left: false, right: false, top: false, bottom: true },
    });
    makeSlope(sim, 4, 0);
    const g = sim.grid;
    sim.sources = [{ id: 's', x: 8, y: 2, radius: 2, maxRate: 0.6 }];
    sim.inflowScale = 1;
    sim.resetBudget();

    run(sim, 35);
    assertSane(sim);

    let downstream = 0;
    let upstream = 0;
    for (let i = 0; i < g.size; i++) {
      if (g.waterDepth[i] <= DEFAULT_PARAMS.minDepth) continue;
      const vy = g.velocityY[i];
      if (vy > 0) downstream += vy;
      else upstream += -vy;
    }
    expect(downstream).toBeGreaterThan(upstream * 20);

    // 下端の開境界まで到達して流出している
    expect(sim.budget.waterOut).toBeGreaterThan(0);

    // 水面が上流へ遡上していない（最上流セルの水位が水源より高くならない）
    let front = 0;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        if (g.waterDepth[g.index(x, y)] > 1e-3) front = Math.max(front, y);
      }
    }
    expect(front).toBeGreaterThan(g.height * 0.8);
  });
});

describe('3. 強い流れの細い水路', () => {
  it('流速の大きい上流で侵食が起き、削られた砂が下流へ運ばれる', () => {
    const W = 20;
    const H = 60;
    const sim = new Simulation(W, H, {
      openBoundary: { left: false, right: false, top: false, bottom: true },
    });
    const g = sim.grid;
    makeSlope(sim, 6, 0);
    // 中央に細い水路を掘る
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.index(x, y);
        const dx = Math.abs(x + 0.5 - W / 2);
        if (dx < 2.5) g.bedHeight[i] -= 0.3 * (1 - dx / 2.5);
      }
    }
    const bed0 = Float32Array.from(g.bedHeight);
    sim.sources = [{ id: 's', x: W / 2, y: 2, radius: 2, maxRate: 1.4 }];
    sim.inflowScale = 1;
    sim.resetBudget();

    run(sim, 40);
    assertSane(sim);

    let erodedUpper = 0;
    let inChannel = 0;
    let outsideChannel = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.index(x, y);
        const diff = bed0[i] - g.bedHeight[i];
        if (diff <= 0) continue;
        if (y < H * 0.5) erodedUpper += diff;
        if (Math.abs(x + 0.5 - W / 2) < 3) inChannel += diff;
        else outsideChannel += diff;
      }
    }
    // 上流側で侵食が発生する
    expect(erodedUpper).toBeGreaterThan(0.5);
    // 侵食は流れの通る水路に集中する
    expect(inChannel).toBeGreaterThan(outsideChannel);
    // 削られた砂は浮遊土砂 or 下流の堆積 or 盤面外流出として存在する
    let suspended = 0;
    let depositedDown = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.index(x, y);
        suspended += g.suspendedSediment[i];
        if (y > H * 0.7) depositedDown += Math.max(0, g.bedHeight[i] - bed0[i]);
      }
    }
    expect(suspended).toBeGreaterThan(0);
    expect(depositedDown + sim.budget.sedimentOut).toBeGreaterThan(0);
  });
});

describe('4. 急斜面から平地への流入', () => {
  it('斜面で運ばれた砂が、流れの弱くなる平地へ堆積する', () => {
    const W = 24;
    const H = 60;
    const sim = new Simulation(W, H);
    const g = sim.grid;
    // 上60%が急斜面、下40%は平地（閉じた盤面なので砂は外へ出ない）
    for (let y = 0; y < H; y++) {
      const t = y / (H - 1);
      const h = t < 0.6 ? 6 * (1 - t / 0.6) : 0;
      for (let x = 0; x < W; x++) g.bedHeight[g.index(x, y)] = h + 0.3;
    }
    const bed0 = Float32Array.from(g.bedHeight);
    sim.sources = [{ id: 's', x: W / 2, y: 2, radius: 2.5, maxRate: 1.5 }];
    sim.inflowScale = 1;
    sim.resetBudget();

    run(sim, 60);
    assertSane(sim);

    let slopeErosion = 0;
    let flatDeposition = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.index(x, y);
        const diff = g.bedHeight[i] - bed0[i];
        if (y < H * 0.6) {
          if (diff < 0) slopeErosion += -diff;
        } else if (diff > 0) flatDeposition += diff;
      }
    }
    expect(slopeErosion).toBeGreaterThan(1);
    // 扇状地状の堆積が平地に生まれる
    expect(flatDeposition).toBeGreaterThan(1);
  });
});

describe('5. 閉じた系の収支', () => {
  it('水量・土砂量の誤差が許容値以内に収まる', () => {
    const sim = new Simulation(32, 32);
    const g = sim.grid;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        g.bedHeight[g.index(x, y)] = 3 - (y / (g.height - 1)) * 2.5 + Math.sin(x * 0.7) * 0.1;
      }
    }
    for (let y = 2; y < 8; y++) {
      for (let x = 10; x < 22; x++) g.waterDepth[g.index(x, y)] = 0.6;
    }
    sim.resetBudget();
    const water0 = sim.stats.waterVolume;
    const sediment0 = sim.stats.sedimentVolume;

    run(sim, 30);
    assertSane(sim);

    expect(Math.abs(sim.stats.waterVolume - water0)).toBeLessThan(1e-3 * Math.max(1, water0));
    expect(Math.abs(sim.stats.sedimentVolume - sediment0)).toBeLessThan(
      1e-3 * Math.max(1, sediment0),
    );
    expect(sim.budget.waterOut).toBe(0);
    expect(sim.budget.sedimentOut).toBe(0);
    expect(sim.budgetWithinTolerance(1e-4)).toBe(true);
  });
});

describe('6. 急激な増水', () => {
  it('流量を上げると流速・侵食・運搬能力が増す', () => {
    function trial(scale: number) {
      const sim = new Simulation(20, 50, {
        openBoundary: { left: false, right: false, top: false, bottom: true },
      });
      makeSlope(sim, 5, 0);
      const g = sim.grid;
      const bed0 = Float32Array.from(g.bedHeight);
      sim.sources = [{ id: 's', x: 10, y: 2, radius: 2, maxRate: 2.0 }];
      sim.inflowScale = scale;
      sim.resetBudget();
      run(sim, 40);
      assertSane(sim);
      let eroded = 0;
      let suspended = 0;
      for (let i = 0; i < g.size; i++) {
        eroded += Math.max(0, bed0[i] - g.bedHeight[i]);
        suspended += g.suspendedSediment[i];
      }
      return { eroded, suspended, maxSpeed: sim.stats.maxSpeed, maxDepth: sim.stats.maxDepth };
    }
    const low = trial(0.25);
    const high = trial(1.0);
    expect(high.maxDepth).toBeGreaterThan(low.maxDepth);
    expect(high.maxSpeed).toBeGreaterThan(low.maxSpeed);
    expect(high.eroded).toBeGreaterThan(low.eroded * 1.5);
    expect(high.suspended).toBeGreaterThan(low.suspended);
  });

  it('増水すると堤防を越えやすくなる', () => {
    function overtop(scale: number) {
      const sim = new Simulation(30, 40, { morphologicalTimeScale: 0 });
      const g = sim.grid;
      makeSlope(sim, 2, 0);
      // 中央に横断する堤防
      for (let x = 0; x < g.width; x++) {
        for (let y = 20; y < 23; y++) g.bedHeight[g.index(x, y)] += 0.35;
      }
      sim.sources = [{ id: 's', x: 15, y: 3, radius: 2, maxRate: 2.5 }];
      sim.inflowScale = scale;
      sim.resetBudget();
      run(sim, 45);
      assertSane(sim);
      let behind = 0;
      for (let y = 25; y < g.height; y++) {
        for (let x = 0; x < g.width; x++) behind += g.waterDepth[g.index(x, y)];
      }
      return behind;
    }
    expect(overtop(1.0)).toBeGreaterThan(overtop(0.2) + 0.05);
  });
});

describe('7. 急激な減水', () => {
  it('運搬能力が下がり、浮遊土砂の堆積が増える', () => {
    const sim = new Simulation(20, 50, {
      openBoundary: { left: false, right: false, top: false, bottom: true },
    });
    makeSlope(sim, 5, 0);
    const g = sim.grid;
    sim.sources = [{ id: 's', x: 10, y: 2, radius: 2, maxRate: 2.0 }];
    sim.inflowScale = 1;
    sim.resetBudget();
    run(sim, 30);
    const suspendedBefore = sim.stats.sedimentVolume;
    let susp0 = 0;
    for (let i = 0; i < g.size; i++) susp0 += g.suspendedSediment[i];
    const deposited0 = sim.stats.depositedVolume;
    expect(susp0).toBeGreaterThan(0);
    expect(suspendedBefore).toBeGreaterThan(0);
    expect(deposited0).toBeGreaterThanOrEqual(0);

    // 水を止める
    sim.inflowScale = 0;
    run(sim, 20);
    assertSane(sim);
    let susp1 = 0;
    for (let i = 0; i < g.size; i++) susp1 += g.suspendedSediment[i];
    // 浮遊土砂は地面に落ちて減る
    expect(susp1).toBeLessThan(susp0 * 0.5);
  });
});

describe('8. 安息角による崩落', () => {
  it('垂直に近い砂の壁が安息角まで崩れ、土砂量は保存される', () => {
    const sim = new Simulation(21, 21, { morphologicalTimeScale: 0 });
    const g = sim.grid;
    g.bedHeight.fill(0);
    // 中央に高い柱を立てる
    for (let y = 9; y <= 11; y++) {
      for (let x = 9; x <= 11; x++) g.bedHeight[g.index(x, y)] = 6;
    }
    sim.resetBudget();
    const total0 = sim.stats.sedimentVolume;

    run(sim, 30);
    assertSane(sim);

    expect(sim.stats.sedimentVolume).toBeCloseTo(total0, 3);

    // 隣接セルとの高さ差が安息角（+わずかな許容）以内に収まる
    let maxDrop = 0;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const i = g.index(x, y);
        if (x + 1 < g.width) maxDrop = Math.max(maxDrop, Math.abs(g.bedHeight[i] - g.bedHeight[i + 1]));
        if (y + 1 < g.height)
          maxDrop = Math.max(maxDrop, Math.abs(g.bedHeight[i] - g.bedHeight[i + g.width]));
      }
    }
    expect(maxDrop).toBeLessThanOrEqual(DEFAULT_PARAMS.reposeTanDry * DEFAULT_PARAMS.cellSize + 0.02);
  });

  it('川岸が下部から侵食されると上部が崩れてくる', () => {
    const sim = new Simulation(21, 21, { morphologicalTimeScale: 0 });
    const g = sim.grid;
    g.bedHeight.fill(0);
    // 安息角ぎりぎりの斜面をつくる
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        g.bedHeight[g.index(x, y)] = Math.max(0, (x - 10) * 0.65);
      }
    }
    run(sim, 5);
    const before = g.bedHeight[g.index(12, 10)];
    // 斜面の脚部を削る（侵食を模す）
    sim.modifyTerrain(11, 10, 1.2, -1.2);
    run(sim, 10);
    assertSane(sim);
    // 上部の砂が落ちてきて高さが下がる
    expect(g.bedHeight[g.index(12, 10)]).toBeLessThan(before);
  });
});

describe('9. 再現性', () => {
  it('同じ初期条件・同じ操作なら結果が一致する', () => {
    function build() {
      const sim = new Simulation(20, 40, {
        openBoundary: { left: false, right: false, top: false, bottom: true },
      });
      makeSlope(sim, 4, 0);
      sim.sources = [{ id: 's', x: 10, y: 2, radius: 2, maxRate: 1.2 }];
      sim.inflowScale = 0.8;
      sim.resetBudget();
      sim.modifyTerrain(10, 20, 3, 0.8);
      run(sim, 20);
      return sim;
    }
    const a = build();
    const b = build();
    for (let i = 0; i < a.grid.size; i++) {
      expect(b.grid.bedHeight[i]).toBe(a.grid.bedHeight[i]);
      expect(b.grid.waterDepth[i]).toBe(a.grid.waterDepth[i]);
    }
  });
});

describe('10. プレイヤー操作と収支', () => {
  it('盛った量・削った量が収支に反映され、岩盤より下は掘れない', () => {
    const sim = new Simulation(20, 20);
    const g = sim.grid;
    g.bedHeight.fill(1);
    g.bedrockHeight.fill(0.5);
    sim.resetBudget();
    const v0 = sim.stats.sedimentVolume;

    const added = sim.modifyTerrain(10, 10, 3, 0.5);
    expect(added).toBeGreaterThan(0);
    expect(sim.budget.sandAdded).toBeCloseTo(added, 6);

    const removed = sim.modifyTerrain(5, 5, 3, -5);
    expect(removed).toBeLessThan(0);
    // 岩盤より下は掘れない
    for (let i = 0; i < g.size; i++) expect(g.bedHeight[i]).toBeGreaterThanOrEqual(0.5 - 1e-6);

    sim.step(1 / 60);
    expect(sim.stats.sedimentVolume).toBeCloseTo(v0 + added + removed, 3);
    expect(sim.budgetWithinTolerance(1e-4)).toBe(true);
  });
});

describe('11. フレームレート非依存', () => {
  it('固定時間刻みが異なっても結果が大きく変わらない', () => {
    function build(dt: number) {
      const sim = new Simulation(20, 40, {
        openBoundary: { left: false, right: false, top: false, bottom: true },
      });
      makeSlope(sim, 4, 0);
      sim.sources = [{ id: 's', x: 10, y: 2, radius: 2, maxRate: 1.2 }];
      sim.inflowScale = 1;
      sim.resetBudget();
      run(sim, 20, dt);
      return sim;
    }
    const fast = build(1 / 60);
    const slow = build(1 / 30);
    assertSane(fast);
    assertSane(slow);
    const rel = Math.abs(fast.stats.waterVolume - slow.stats.waterVolume) /
      Math.max(1e-6, fast.stats.waterVolume);
    expect(rel).toBeLessThan(0.1);
  });
});

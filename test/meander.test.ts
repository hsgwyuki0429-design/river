import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation.ts';
import { applyTerrainOps } from '../src/sim/terrain.ts';

function run(sim: Simulation, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
}

function totalWater(sim: Simulation): number {
  return sim.stats.waterVolume + sim.circulation.water;
}

function totalSediment(sim: Simulation): number {
  return sim.stats.sedimentVolume + sim.stats.circulationSediment;
}

describe('有限タンクによる上下循環', () => {
  it('下端を出た水と土砂が左右へ混ざらず同じX列の上端へ戻る', () => {
    const sim = new Simulation(9, 12, {
      circulationEnabled: true,
      fluxGain: 0,
      morphologicalTimeScale: 0,
    });
    const g = sim.grid;
    sim.sources = [{ id: 'pump', x: 4, y: 0, radius: 1, maxRate: 0.5 }];
    sim.seedCirculation(0);

    const exitX = 6;
    sim.circulation.water = 1;
    sim.circulation.suspendedSediment = 0.2;
    sim.circulation.bedloadSediment = 0.1;
    sim.circulationWaterByColumn[exitX] = 1;
    sim.circulationSuspendedSedimentByColumn[exitX] = 0.2;
    sim.circulationBedloadSedimentByColumn[exitX] = 0.1;
    sim.inflowScale = 1;
    sim.resetBudget();
    sim.step(1);

    expect(g.waterDepth[g.index(exitX, 0)]).toBeCloseTo(0.5, 6);
    expect(g.suspendedSediment[g.index(exitX, 0)]).toBeCloseTo(0.1, 6);
    expect(g.bedloadSediment[g.index(exitX, 0)]).toBeCloseTo(0.05, 6);
    for (let x = 0; x < g.width; x++) {
      if (x === exitX) continue;
      expect(g.waterDepth[g.index(x, 0)]).toBe(0);
      expect(g.suspendedSediment[g.index(x, 0)]).toBe(0);
      expect(g.bedloadSediment[g.index(x, 0)]).toBe(0);
    }
    expect(sim.circulationWaterByColumn[exitX]).toBeCloseTo(0.5, 6);
    expect(sim.circulationSuspendedSedimentByColumn[exitX]).toBeCloseTo(0.1, 6);
    expect(sim.circulationBedloadSedimentByColumn[exitX]).toBeCloseTo(0.05, 6);
    expect(sim.budgetWithinTolerance(1e-6)).toBe(true);
  });

  it('水と浮遊砂・掃流砂を必ず同じ割合で放出し、保有量を超えない', () => {
    const sim = new Simulation(12, 20, {
      circulationEnabled: true,
      morphologicalTimeScale: 0,
    });
    sim.sources = [{ id: 'pump', x: 6, y: 0, radius: 2, maxRate: 60 }];
    sim.seedCirculation(5, 1, 0.5);
    sim.inflowScale = 1;
    sim.resetBudget();
    sim.step(1 / 60);

    expect(sim.circulation.releasedWater).toBeCloseTo(1, 6);
    expect(sim.circulation.releasedSediment).toBeCloseTo(0.3, 6);
    expect(sim.circulation.water).toBeCloseTo(4, 6);
    expect(sim.circulation.suspendedSediment).toBeCloseTo(0.8, 6);
    expect(sim.circulation.bedloadSediment).toBeCloseTo(0.4, 6);
    expect(sim.budget.waterAdded).toBe(0);
    expect(sim.budget.sedimentOut).toBe(0);

    sim.seedCirculation(0.25, 0.05, 0.025);
    sim.resetBudget();
    sim.step(1 / 60);
    expect(sim.circulation.releasedWater).toBeCloseTo(0.25, 6);
    expect(sim.circulation.water).toBe(0);
    expect(sim.circulation.suspendedSediment).toBe(0);
    expect(sim.circulation.bedloadSediment).toBe(0);
  });

  it('下端の水と濃度に応じた浮遊砂がタンクへ入り、次の刻みから上端へ戻る', () => {
    const sim = new Simulation(16, 24, {
      circulationEnabled: true,
      morphologicalTimeScale: 0,
    });
    const g = sim.grid;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) g.bedHeight[g.index(x, y)] = 2 - y * 0.04;
    }
    for (let x = 5; x <= 10; x++) {
      const i = g.index(x, g.height - 1);
      g.waterDepth[i] = 0.4;
      g.suspendedSediment[i] = 0.04;
    }
    sim.sources = [{ id: 'pump', x: 8, y: 0, radius: 2, maxRate: 1 }];
    sim.inflowScale = 0;
    sim.seedCirculation(0);
    sim.resetBudget();
    run(sim, 1);
    expect(sim.circulation.water).toBeGreaterThan(0);
    expect(sim.circulation.suspendedSediment).toBeGreaterThan(0);
    expect(sim.budget.waterOut).toBe(0);
    const released0 = sim.circulation.releasedWater;
    sim.inflowScale = 1;
    run(sim, 0.5);
    expect(sim.circulation.releasedWater).toBeGreaterThan(released0);
    let topWater = 0;
    for (let y = 0; y < 3; y++) for (let x = 0; x < g.width; x++) topWater += g.waterDepth[g.index(x, y)];
    expect(topWater).toBeGreaterThan(0);
    expect(sim.budget.waterAdded).toBe(0);
  });

  it('ポンプ0で停止し、長時間後も盤面＋タンクの水と全土砂を保存する', () => {
    const sim = new Simulation(20, 36, {
      circulationEnabled: true,
      meanderDynamics: true,
      morphologicalTimeScale: 5,
    });
    const g = sim.grid;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) g.bedHeight[g.index(x, y)] = 3 - y * 0.05;
    }
    sim.sources = [{ id: 'pump', x: 10, y: 0, radius: 2.5, maxRate: 1.2 }];
    sim.seedCirculation(12, 0.6, 0.2);
    sim.inflowScale = 0;
    sim.resetBudget();
    const w0 = totalWater(sim);
    const s0 = totalSediment(sim);
    run(sim, 1);
    expect(sim.circulation.releasedWater).toBe(0);
    sim.inflowScale = 0.8;
    run(sim, 15);
    expect(Math.abs(totalWater(sim) - w0) / Math.max(1, w0)).toBeLessThan(1e-5);
    expect(Math.abs(totalSediment(sim) - s0) / Math.max(1, s0)).toBeLessThan(1e-5);
    expect(sim.budgetWithinTolerance(1e-4)).toBe(true);
    expect(sim.validate().faults).toBe(0);
  }, 60000);
});

describe('8近傍流束の方向依存性', () => {
  function directionalSpeed(diagonal: boolean): number {
    const sim = new Simulation(25, 25, { morphologicalTimeScale: 0, diagonalFlowEnabled: true });
    const g = sim.grid;
    const inv = 1 / Math.SQRT2;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        g.bedHeight[g.index(x, y)] = diagonal ? -(x + y) * 0.025 * inv : -y * 0.025;
        g.waterDepth[g.index(x, y)] = 0.18;
      }
    }
    sim.resetBudget();
    run(sim, 0.5);
    const i = g.index(12, 12);
    return Math.hypot(g.velocityX[i], g.velocityY[i]);
  }

  it('直線勾配と斜め勾配で速度が同程度で、斜めだけ異常加速しない', () => {
    const straight = directionalSpeed(false);
    const diagonal = directionalSpeed(true);
    expect(diagonal / straight).toBeGreaterThan(0.55);
    expect(diagonal / straight).toBeLessThan(1.45);
    expect(diagonal).toBeLessThan(5);
  });

  it('平坦で対称な水塊の重心が一方向へ偏り続けない', () => {
    const sim = new Simulation(25, 25, { morphologicalTimeScale: 0, diagonalFlowEnabled: true });
    const g = sim.grid;
    for (let y = 9; y <= 15; y++) for (let x = 9; x <= 15; x++) g.waterDepth[g.index(x, y)] = 0.3;
    sim.resetBudget();
    run(sim, 5);
    let mass = 0;
    let mx = 0;
    let my = 0;
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      const d = g.waterDepth[g.index(x, y)];
      mass += d;
      mx += (x + 0.5) * d;
      my += (y + 0.5) * d;
    }
    expect(mx / mass).toBeCloseTo(12.5, 3);
    expect(my / mass).toBeCloseTo(12.5, 3);
  });
});

describe('曲率・外岸侵食・内岸堆積', () => {
  it('水面勾配があっても流速ゼロの水はその場で河床や河岸を掘らない', () => {
    const sim = new Simulation(11, 11, {
      meanderDynamics: true,
      morphologicalTimeScale: 12,
      criticalShear: 0.1,
      bankErosionRate: 3e-4,
    });
    const g = sim.grid;
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      const i = g.index(x, y);
      g.bedHeight[i] = 1 + x * 0.08;
      g.waterDepth[i] = 0.2;
      g.smoothedVelocityY[i] = 1;
      g.secondaryFlow[i] = 0.4;
    }
    const before = Float32Array.from(g.bedHeight);
    sim.erodeAndDeposit(0.25);
    sim.applyBankProcesses(0.25);
    for (let i = 0; i < g.size; i++) {
      expect(g.bedHeight[i]).toBe(before[i]);
      expect(g.bedloadSediment[i]).toBe(0);
      expect(g.bankErosionRecent[i]).toBe(0);
    }
  });

  it('同じ勾配でも実際に流れていれば掃流砂として侵食する', () => {
    const sim = new Simulation(11, 11, {
      meanderDynamics: true,
      morphologicalTimeScale: 12,
      criticalShear: 0.1,
      capacityRate: 1,
    });
    const g = sim.grid;
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      const i = g.index(x, y);
      g.bedHeight[i] = 1 + x * 0.08;
      g.waterDepth[i] = 0.2;
      g.velocityX[i] = 0.7;
    }
    const i = g.index(5, 5);
    const before = g.bedHeight[i];
    sim.erodeAndDeposit(0.25);
    expect(g.bedHeight[i]).toBeLessThan(before);
    expect(g.bedloadSediment[i]).toBeGreaterThan(0);
  });

  it('曲がった流れは符号付き曲率と遅れた二次流を作り、外岸だけを強く侵食する', () => {
    const sim = new Simulation(31, 31, {
      meanderDynamics: true,
      morphologicalTimeScale: 8,
      criticalShear: 0.1,
      bankErosionRate: 3e-4,
    });
    const g = sim.grid;
    const cx = 15;
    const cy = 15;
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      const i = g.index(x, y);
      g.bedHeight[i] = 2 - y * 0.035;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (Math.abs(r - 8) < 1.6) {
        g.waterDepth[i] = 0.24;
        g.velocityX[i] = -dy / Math.max(r, 1);
        g.velocityY[i] = dx / Math.max(r, 1);
      }
    }
    for (let n = 0; n < 180; n++) sim.updateFlowGeometry(1 / 60);
    let curve = 0;
    let secondary = 0;
    let wet = 0;
    for (let i = 0; i < g.size; i++) if (g.waterDepth[i] > 0) {
      curve += g.curvature[i];
      secondary += g.secondaryFlow[i];
      wet++;
    }
    expect(curve / wet).toBeGreaterThan(0.04);
    expect(secondary / wet).toBeGreaterThan(0.015);
    sim.applyBankProcesses(0.1);
    let outer = 0;
    let inner = 0;
    for (let i = 0; i < g.size; i++) {
      if (g.bankSide[i] > 0) outer += g.bankErosionRecent[i];
      else if (g.bankSide[i] < 0) inner += g.bankErosionRecent[i];
    }
    expect(outer).toBeGreaterThan(0);
    expect(outer).toBeGreaterThan(inner * 5);
  });

  it('同じ低速・土砂条件では内岸の点砂州堆積が外岸より大きい', () => {
    const sim = new Simulation(9, 9, {
      meanderDynamics: true,
      morphologicalTimeScale: 8,
      capacityRate: 0,
      depositionRate: 0,
      bedloadRate: 0,
      pointBarDepositionGain: 1.2,
    });
    const g = sim.grid;
    const inner = g.index(3, 4);
    const outer = g.index(5, 4);
    for (const i of [inner, outer]) {
      g.waterDepth[i] = 0.2;
      g.suspendedSediment[i] = 0.04;
      g.velocityY[i] = 0.2;
      g.secondaryFlow[i] = 0.4;
    }
    g.bankSide[inner] = -1;
    g.bankSide[outer] = 1;
    const beforeInner = g.bedHeight[inner];
    const beforeOuter = g.bedHeight[outer];
    sim.erodeAndDeposit(0.1);
    expect(g.bedHeight[inner] - beforeInner).toBeGreaterThan(g.bedHeight[outer] - beforeOuter);
    expect(g.bedHeight[inner]).toBeGreaterThan(beforeInner);
  });
});

describe('三日月湖の読み取り専用検出', () => {
  it('本流から切れた細長い低速水域を検出し、地形と水を変更しない', () => {
    const sim = new Simulation(30, 40, { oxbowMinAge: 2, oxbowMinArea: 8 });
    const g = sim.grid;
    for (let y = 0; y < g.height; y++) g.waterDepth[g.index(4, y)] = 0.2;
    for (let y = 13; y <= 25; y++) {
      for (let x = 18; x <= 20; x++) {
        const i = g.index(x, y);
        g.waterDepth[i] = 0.16;
        g.lowVelocityAge[i] = 3;
      }
    }
    const bed0 = Float32Array.from(g.bedHeight);
    const water0 = Float32Array.from(g.waterDepth);
    const count = sim.detectOxbows(0);
    expect(count).toBe(1);
    let marked = 0;
    for (let i = 0; i < g.size; i++) {
      marked += g.oxbowCandidate[i];
      expect(g.bedHeight[i]).toBe(bed0[i]);
      expect(g.waterDepth[i]).toBe(water0[i]);
    }
    expect(marked).toBe(39);
  });

  it('同じ初期状態と操作では蛇行用の全物理状態が再現する', () => {
    function build(): Simulation {
      const sim = new Simulation(18, 36, {
        circulationEnabled: true,
        meanderDynamics: true,
        morphologicalTimeScale: 5,
      });
      const g = sim.grid;
      for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
        g.bedHeight[g.index(x, y)] = 3 - y * 0.05 + Math.sin(x * 0.7 + y * 0.11) * 0.01;
      }
      sim.sources = [{ id: 'pump', x: 9, y: 0, radius: 2, maxRate: 1.1 }];
      sim.seedCirculation(8, 0.2);
      sim.inflowScale = 0.7;
      sim.resetBudget();
      run(sim, 5);
      return sim;
    }
    const a = build();
    const b = build();
    expect(b.circulation.water).toBe(a.circulation.water);
    for (let i = 0; i < a.grid.size; i++) {
      expect(b.grid.bedHeight[i]).toBe(a.grid.bedHeight[i]);
      expect(b.grid.waterDepth[i]).toBe(a.grid.waterDepth[i]);
      expect(b.grid.secondaryFlow[i]).toBe(a.grid.secondaryFlow[i]);
      expect(b.grid.bedloadSediment[i]).toBe(a.grid.bedloadSediment[i]);
    }
  }, 60000);
});

describe('河道切断の物理過程', () => {
  it('細い首の越流侵食で短い流路の流量が増え、旧ループ入口に堆積する', () => {
    const sim = new Simulation(36, 54, {
      diagonalFlowEnabled: true,
      meanderDynamics: true,
      morphologicalTimeScale: 18,
      criticalShear: 2,
      erosionRate: 7e-5,
      bankErosionRate: 3e-5,
      openBoundary: { left: false, right: false, top: false, bottom: true },
    });
    const g = sim.grid;
    applyTerrainOps(g, [
      { type: 'slope', high: 5, low: 0.8, dir: 'down' },
      {
        type: 'channel',
        points: [
          [0.5, 0], [0.5, 0.16], [0.22, 0.25], [0.16, 0.45], [0.25, 0.64],
          [0.52, 0.70], [0.78, 0.62], [0.84, 0.42], [0.74, 0.24], [0.62, 0.24], [0.5, 1],
        ],
        width: 0.032,
        depth: 0.34,
      },
      { type: 'hill', x: 0.56, y: 0.2, radius: 0.065, height: -0.16 },
    ]);
    sim.sources = [{ id: 'flood', x: 18, y: 1, radius: 2.5, maxRate: 3.2 }];
    sim.inflowScale = 1;
    sim.resetBudget();
    const neckCells: number[] = [];
    for (let y = 8; y <= 13; y++) for (let x = 18; x <= 22; x++) neckCells.push(g.index(x, y));
    const neckBefore = Float32Array.from(neckCells, (i) => g.bedHeight[i]);
    run(sim, 36);
    let maxNeckErosion = 0;
    for (let n = 0; n < neckCells.length; n++) {
      maxNeckErosion = Math.max(maxNeckErosion, neckBefore[n] - g.bedHeight[neckCells[n]]);
    }
    let shortcutFlux = 0;
    let oldLoopFlux = 0;
    let shortcutCount = 0;
    let oldCount = 0;
    for (let y = 7; y <= 15; y++) for (let x = 17; x <= 23; x++) {
      const i = g.index(x, y);
      shortcutFlux += Math.hypot(g.velocityX[i], g.velocityY[i]) * g.waterDepth[i];
      shortcutCount++;
    }
    for (let y = 13; y <= 35; y++) for (const x of [5, 6, 7, 28, 29, 30]) {
      const i = g.index(x, y);
      oldLoopFlux += Math.hypot(g.velocityX[i], g.velocityY[i]) * g.waterDepth[i];
      oldCount++;
    }
    expect(maxNeckErosion).toBeGreaterThan(0.01);
    expect(shortcutFlux / shortcutCount).toBeGreaterThan(oldLoopFlux / oldCount);

    const entryCells: number[] = [];
    for (let y = 11; y <= 17; y++) for (let x = 7; x <= 15; x++) entryCells.push(g.index(x, y));
    const entryBefore = entryCells.reduce((sum, i) => sum + g.bedHeight[i], 0);
    sim.inflowScale = 0.18;
    run(sim, 12);
    const entryAfter = entryCells.reduce((sum, i) => sum + g.bedHeight[i], 0);
    let oldLoopAfter = 0;
    for (let y = 13; y <= 35; y++) for (const x of [5, 6, 7, 28, 29, 30]) {
      const i = g.index(x, y);
      oldLoopAfter += Math.hypot(g.velocityX[i], g.velocityY[i]) * g.waterDepth[i];
    }
    expect(oldLoopAfter).toBeLessThan(oldLoopFlux);
    expect(entryAfter).toBeGreaterThan(entryBefore);
    expect(sim.budgetWithinTolerance(1e-4)).toBe(true);
  }, 120000);
});

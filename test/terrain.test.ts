import { describe, expect, it } from 'vitest';
import { RiverModel, decodeSave, resample } from '../src/observatory/model.ts';
import { TERRAIN, TerrainStroke, flatTerrain, paintTerrain, reliefAt, terrainAllowsCutoff } from '../src/observatory/terrain.ts';

const run = (m: RiverModel, years: number) => { for (let i = 0; i < years * 4; i++) m.step(); };
const straight = () => { const m = new RiverModel(); m.state.points = resample([{ x: 0, y: 0 }, { x: 1800, y: 0 }]); return m; };

describe('editable elevation and river response', () => {
  it('paints smooth bounded elevations without modifying past terrain', () => {
    const flat = flatTerrain(), point = { x: 900, y: 0 };
    const hill = paintTerrain(flat, [point], 140, 3, 'raise');
    expect(reliefAt(flat, point)).toBe(0);
    expect(reliefAt(hill, point)).toBeGreaterThan(2.5);
    expect(reliefAt(hill, { x: 950, y: 0 })).toBeLessThan(reliefAt(hill, point));
    expect(reliefAt(hill, { x: 1100, y: 0 })).toBe(0);
    const restored = paintTerrain(hill, [point], 140, 3, 'restore');
    expect(restored.heights).toEqual(flat.heights);
    let field = hill;
    for (let i = 0; i < 30; i++) field = paintTerrain(field, [point], 140, 3, 'raise');
    expect(Math.max(...field.heights)).toBe(TERRAIN.limit);
  });

  it('moves the river away from a raised bank and toward an excavated bank', () => {
    const raised = straight(), lowered = straight(), baseline = straight();
    const bank = [{ x: 900, y: 90 }];
    raised.state.terrain = paintTerrain(raised.state.terrain, bank, 240, 3, 'raise');
    lowered.state.terrain = paintTerrain(lowered.state.terrain, bank, 240, 3, 'lower');
    const before = raised.snapshot();
    run(raised, 15); run(lowered, 15); run(baseline, 15);
    const localY = (m: RiverModel) => m.state.points.filter(p => p.x > 850 && p.x < 950).reduce((sum, p, _, a) => sum + p.y / a.length, 0);
    expect(localY(baseline)).toBeCloseTo(0, 9);
    expect(localY(raised)).toBeLessThan(-10);
    expect(localY(lowered)).toBeGreaterThan(10);
    expect(before.points.every(p => p.y === 0)).toBe(true);
    expect(before.terrain).toBe(raised.state.terrain);
  });

  it('a raised neck blocks a shortcut even when channel points are close', () => {
    const flat = flatTerrain(), a = { x: 820, y: 0 }, b = { x: 980, y: 0 };
    const hill = paintTerrain(flat, [{ x: 900, y: 0 }], 80, 3, 'raise');
    expect(terrainAllowsCutoff(flat, a, b, 0.25)).toBe(true);
    expect(terrainAllowsCutoff(hill, a, b, 0.25)).toBe(false);
    expect(terrainAllowsCutoff(paintTerrain(hill, [{ x: 900, y: 0 }], 80, 3, 'restore'), a, b, 0.25)).toBe(true);
  });

  it('produces the same continuous brush stroke at different pointer event rates', () => {
    const a = new TerrainStroke({ x: 0, y: 0 }, 40), b = new TerrainStroke({ x: 0, y: 0 }, 40);
    const samples = Array.from({ length: 10 }, (_, i) => ({ x: (i + 1) * 25, y: 0 }));
    expect(samples.flatMap(p => b.move(p))).toEqual(a.move({ x: 250, y: 0 }));
  });

  it('restores edited terrain and the identical subsequent river evolution', () => {
    const first = new RiverModel();
    first.state.terrain = paintTerrain(first.state.terrain, [{ x: 850, y: 90 }, { x: 980, y: 100 }], 240, 3, 'raise');
    run(first, 20);
    const raw = JSON.stringify({ version: 2, seed: 42, state: first.snapshot() });
    const copy = new RiverModel(); copy.state = decodeSave(raw).state;
    run(first, 30); run(copy, 30);
    expect(copy.state).toEqual(first.state);
  });

  it('migrates old saves without terrain and rejects invalid height data', () => {
    const { terrain: _, ...old } = new RiverModel().snapshot();
    expect(decodeSave(JSON.stringify({ version: 1, seed: 42, state: old })).state.terrain).toEqual(flatTerrain());
    for (const terrain of [undefined, { heights: [] }, { heights: Array(TERRAIN.cols * TERRAIN.rows).fill(13) }]) {
      expect(() => decodeSave(JSON.stringify({ version: 2, seed: 42, state: { ...old, terrain } }))).toThrow();
    }
  });

  it('remains finite with alternating hills and trenches through the full observation', () => {
    const m = new RiverModel();
    for (let i = 0; i < 12; i++) {
      m.state.terrain = paintTerrain(m.state.terrain, [{ x: 350 + (i % 6) * 230, y: i < 6 ? 70 : -90 }], 140, 3, i % 2 ? 'lower' : 'raise');
    }
    run(m, 1200);
    expect(m.state.points.length).toBeLessThan(2000);
    expect(m.state.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(() => decodeSave(JSON.stringify({ version: 2, seed: 42, state: m.state }))).not.toThrow();
  }, 20000);
});

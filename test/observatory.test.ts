import { describe, expect, it } from 'vitest';
import { RiverModel, PRESETS, END_YEAR, STEP, decodeSave, distance, findNeck, resample, sinuosity } from '../src/observatory/model.ts';

const advance = (model: RiverModel, year: number) => { while (model.state.year < year) model.step(); };

describe('river observatory', () => {
  it('grows bends and creates geometric cutoffs within the default observation window', () => {
    const river = new RiverModel(), start = river.snapshot();
    advance(river, 30);
    expect(sinuosity(river.state.points)).toBeGreaterThan(sinuosity(start.points) + 0.25);
    advance(river, 160);
    expect(river.state.cutoffs).toBeGreaterThan(0);
    expect(river.state.oxbows.length).toBe(river.state.cutoffs);
    expect(river.state.oxbows[0].born).toBeGreaterThan(0);
    expect(start.oxbows).toHaveLength(0);
    expect(start.year).toBe(0);
  });

  it('cuts a narrow neck, never an adjacent bend or an open straight reach', () => {
    const line = resample([{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
    expect(findNeck(line, 32)).toBeNull();
    const loop = resample([{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 250, y: -150 }, { x: 400, y: -100 }, { x: 400, y: 100 }, { x: 250, y: 150 }, { x: 150, y: 20 }, { x: 0, y: 20 }]);
    expect(findNeck(loop, 32)).not.toBeNull();
    expect(findNeck(loop, 10)).toBeNull();
  });

  it('responds to bank mobility and temporary flooding, and expires floods in model time', () => {
    const hard = new RiverModel(42, 1, 0.3), soft = new RiverModel(42, 1, 1.8), flood = new RiverModel();
    flood.flood();
    advance(hard, 20); advance(soft, 20); advance(flood, 20);
    expect(sinuosity(soft.state.points)).toBeGreaterThan(sinuosity(hard.state.points));
    expect(flood.state.floodUntil).toBe(flood.state.year);
    expect(flood.state.points).not.toEqual(hard.state.points);
  });

  it('keeps a straight channel straight: events are not driven by elapsed time', () => {
    const river = new RiverModel();
    river.state.points = resample([{ x: 0, y: 0 }, { x: 1800, y: 0 }]);
    advance(river, 200);
    expect(river.state.cutoffs).toBe(0);
    expect(sinuosity(river.state.points)).toBeCloseTo(1, 10);
  });

  it.each(PRESETS)('remains finite and connected through 1,200 years: $name', preset => {
    const river = new RiverModel(preset.seed, preset.flow, preset.erodibility);
    advance(river, END_YEAR);
    const s = river.state;
    expect(s.points.length).toBeLessThan(2000);
    expect(s.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(Math.max(...s.points.slice(1).map((p, i) => distance(p, s.points[i])))).toBeLessThan(12.1);
    expect(s.points[0]).toEqual({ x: 0, y: 0 });
    expect(s.points.at(-1)!.x).toBe(1800);
    const before = river.snapshot(); river.step(); expect(river.state).toEqual(before);
    expect(() => decodeSave(JSON.stringify({ version: 1, seed: preset.seed, state: s }))).not.toThrow();
  }, 20000);

  it('restores the exact continuation including oxbows and active floods', () => {
    const first = new RiverModel(); advance(first, 160); first.flood();
    const parsed = decodeSave(JSON.stringify({ version: 1, seed: 42, state: first.snapshot() }));
    const restored = new RiverModel(parsed.seed); restored.state = parsed.state;
    advance(first, 200); advance(restored, 200);
    expect(restored.state).toEqual(first.state);
    expect(restored.state.year % STEP).toBe(0);
  });

  it('rejects corrupt and incompatible saves before replacing the live model', () => {
    expect(() => decodeSave('null')).toThrow();
    expect(() => decodeSave('{')).toThrow();
    const state = new RiverModel().snapshot();
    for (const bad of [{ ...state, flow: 0 }, { ...state, year: 1.1 }, { ...state, points: [] }, { ...state, cutoffs: -1 }, { ...state, points: state.points.map(() => ({ x: 0, y: 0 })) }]) {
      expect(() => decodeSave(JSON.stringify({ version: 1, seed: 42, state: bad }))).toThrow();
    }
  });
});

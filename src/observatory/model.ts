/**
 * Educational, uncalibrated planform model (metres / illustrative model years).
 * Curvature and an exponentially weighted upstream memory determine migration;
 * this is not a shallow-water or sediment-budget solver. Inspired by the
 * Howard–Knutson family of models; see docs/observatory.md for assumptions.
 * No elapsed-time event triggers or prerecorded channel shapes are used.
 */
export interface Point { x: number; y: number }
export interface Oxbow { points: Point[]; born: number; width: number }
export interface RiverState {
  year: number;
  points: Point[];
  oxbows: Oxbow[];
  cutoffs: number;
  flow: number;
  erodibility: number;
  floodUntil: number;
}
export const STEP = 0.25;
export const END_YEAR = 1200;
export const REACH = 1800;
export const SPACING = 12;
export const PRESETS = [
  { id: 'plain', name: '草原の川', description: '広い氾濫原を、自由に蛇行する。', flow: 1, erodibility: 1, seed: 42 },
  { id: 'sand', name: '砂地の川', description: 'やわらかい川岸。変化を速く観察。', flow: 1.25, erodibility: 1.5, seed: 137 },
  { id: 'forest', name: '森の川', description: '動きにくい川岸で、ゆっくり育つ。', flow: 0.85, erodibility: 0.5, seed: 891 },
] as const;

export function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
export function length(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
  return sum;
}
export function channelWidth(flow: number): number { return 32 * Math.sqrt(flow); }
export function sinuosity(points: readonly Point[]): number {
  return length(points) / Math.max(1, distance(points[0], points[points.length - 1]));
}
export function resample(points: readonly Point[]): Point[] {
  const total = length(points), count = Math.max(2, Math.ceil(total / SPACING));
  const result = [{ ...points[0] }];
  let segment = 1, passed = 0;
  for (let k = 1; k < count; k++) {
    const target = total * k / count;
    while (segment < points.length - 1 && passed + distance(points[segment - 1], points[segment]) < target) {
      passed += distance(points[segment - 1], points[segment]);
      segment++;
    }
    const a = points[segment - 1], b = points[segment];
    const t = (target - passed) / Math.max(1e-9, distance(a, b));
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  result.push({ ...points[points.length - 1] });
  return result;
}

export function curvature(points: readonly Point[]): Float64Array {
  const raw = new Float64Array(points.length), result = new Float64Array(points.length);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    raw[i] = 2 * cross / Math.max(1e-9, distance(a, b) * distance(b, c) * distance(a, c));
  }
  for (let i = 2; i < points.length - 2; i++) result[i] = (raw[i - 1] + 2 * raw[i] + raw[i + 1]) / 4;
  return result;
}

/** Spatial hash avoids a quadratic scan; arc separation excludes adjacent banks. */
export function findNeck(points: readonly Point[], width: number): [number, number] | null {
  const threshold = width * 0.92, bins = new Map<string, number[]>();
  const arc = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) arc[i] = arc[i - 1] + distance(points[i - 1], points[i]);
  for (let j = 0; j < points.length; j++) {
    const p = points[j], bx = Math.floor(p.x / threshold), by = Math.floor(p.y / threshold);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of bins.get(`${bx + dx},${by + dy}`) ?? []) {
        if (arc[j] - arc[i] > width * 6 && distance(points[i], p) < threshold) return [i, j];
      }
    }
    const key = `${bx},${by}`;
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key)!.push(j);
  }
  return null;
}

export class RiverModel {
  state: RiverState;
  constructor(seed = 42, flow = 1, erodibility = 1) {
    const phase = (seed % 101) / 101 * Math.PI;
    const points: Point[] = [];
    for (let i = 0; i <= 240; i++) {
      const x = REACH * i / 240, envelope = Math.sin(Math.PI * i / 240) ** 0.5;
      points.push({ x, y: envelope * (92 * Math.sin(x / 83 + phase) + 21 * Math.sin(x / 143 + phase * 2)) });
    }
    this.state = { year: 0, points: resample(points), oxbows: [], cutoffs: 0, flow, erodibility, floodUntil: 0 };
  }

  snapshot(): RiverState {
    return { ...this.state, points: this.state.points.map(p => ({ ...p })), oxbows: [...this.state.oxbows] };
  }

  flood(): void { this.state.floodUntil = Math.min(END_YEAR, this.state.year + 20); }

  step(): void {
    const s = this.state;
    if (s.year >= END_YEAR) return;
    const p = s.points, n = p.length, c = curvature(p);
    const width = channelWidth(s.flow), flooded = s.year < s.floodUntil;
    const memory = width * 2.3;
    const rate = 24 * s.erodibility * s.flow ** 0.7 * (flooded ? 2.2 : 1);
    const slopeFactor = sinuosity(p) ** (-2 / 3);
    let weighted = 0, weights = 0, arc = 0;
    const total = length(p), next: Point[] = [];
    for (let i = 0; i < n; i++) {
      const ds = i ? distance(p[i - 1], p[i]) : SPACING;
      arc += i ? ds : 0;
      const decay = Math.exp(-ds / memory);
      weighted = weighted * decay + c[i] * width;
      weights = weights * decay + 1;
      if (i < 2 || i > n - 3) { next.push({ ...p[i] }); continue; }
      const tx = p[i + 1].x - p[i - 1].x, ty = p[i + 1].y - p[i - 1].y;
      const norm = Math.hypot(tx, ty);
      const taper = Math.min(1, arc / 150, (total - arc) / 150) ** 2;
      const migration = rate * (-width * c[i] + 2.5 * weighted / weights) * slopeFactor;
      const move = Math.max(-SPACING * 0.15, Math.min(SPACING * 0.15, migration * STEP)) * taper;
      next.push({ x: p[i].x + move * ty / norm, y: p[i].y - move * tx / norm });
    }
    s.year = Math.min(END_YEAR, s.year + STEP);
    s.points = next;
    // Width determines bank contact; floods accelerate migration, not cutoff timing.
    const neck = findNeck(s.points, width);
    if (neck) {
      const [a, b] = neck;
      s.oxbows.push({ points: s.points.slice(a, b + 1).map(p => ({ ...p })), born: s.year, width });
      s.cutoffs++;
      s.points = [...s.points.slice(0, a + 1), ...s.points.slice(b)];
    }
    s.points = resample(s.points);
  }
}

/** Storage is a separate namespace from the original sandbox's v1–v3 saves. */
export const SAVE_KEY = 'river-observatory-v1';
export function decodeSave(raw: string): { state: RiverState; seed: number } {
  if (raw.length > 2_000_000) throw new Error('Save too large');
  const data = JSON.parse(raw) as { version: number; seed: number; state: RiverState };
  const s = data?.state;
  const finiteRange = (v: number, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const validPoints = (p: Point[], min: number) => Array.isArray(p) && p.length >= min && p.length <= 4000 && p.every(v => v && finiteRange(v.x, -10000, 10000) && finiteRange(v.y, -10000, 10000));
  if (data.version !== 1 || !Number.isInteger(data.seed) || !s || !finiteRange(s.year, 0, END_YEAR) || s.year % STEP !== 0 ||
      !finiteRange(s.flow, 0.5, 1.8) || !finiteRange(s.erodibility, 0.3, 1.8) || !finiteRange(s.floodUntil, 0, END_YEAR) ||
      !validPoints(s.points, 10) || !Array.isArray(s.oxbows) || s.oxbows.length > 200 || !Number.isInteger(s.cutoffs) || s.cutoffs !== s.oxbows.length ||
      s.oxbows.some(o => !o || !validPoints(o.points, 3) || !finiteRange(o.born, 0, s.year) || !finiteRange(o.width, 10, 100))) throw new Error('Invalid save');
  if (s.points.some((p, i) => i > 0 && distance(p, s.points[i - 1]) < 1e-6)) throw new Error('Degenerate channel');
  return { state: s, seed: data.seed };
}

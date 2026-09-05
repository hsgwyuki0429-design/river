import type { Point } from './model.ts';

// Heights are changes in metres relative to the initial, downstream-sloping plain.
// Published fields are immutable: a stroke produces a new array, so historical
// frames and undo records can safely share their previous terrain.
export const TERRAIN = { x: -1500, y: -3200, cell: 40, cols: 121, rows: 161, limit: 12 } as const;
export interface TerrainField { readonly heights: readonly number[] }
export type TerrainTool = 'raise' | 'lower' | 'restore';
export function flatTerrain(): TerrainField {
  return { heights: Array<number>(TERRAIN.cols * TERRAIN.rows).fill(0) };
}
export function insideTerrain(p: Point): boolean {
  return p.x >= TERRAIN.x && p.x <= TERRAIN.x + (TERRAIN.cols - 1) * TERRAIN.cell &&
    p.y >= TERRAIN.y && p.y <= TERRAIN.y + (TERRAIN.rows - 1) * TERRAIN.cell;
}
/** Bilinear interpolation of the edited elevation, zero outside the field. */
export function reliefAt(field: TerrainField, p: Point): number {
  if (!insideTerrain(p)) return 0;
  const gx = (p.x - TERRAIN.x) / TERRAIN.cell, gy = (p.y - TERRAIN.y) / TERRAIN.cell;
  const x = Math.min(TERRAIN.cols - 2, Math.floor(gx)), y = Math.min(TERRAIN.rows - 2, Math.floor(gy));
  const u = gx - x, v = gy - y, i = y * TERRAIN.cols + x, z = field.heights;
  return (z[i] * (1 - u) + z[i + 1] * u) * (1 - v) + (z[i + TERRAIN.cols] * (1 - u) + z[i + TERRAIN.cols + 1] * u) * v;
}
export function paintTerrain(field: TerrainField, centers: readonly Point[], radius: number, amount: number, tool: TerrainTool): TerrainField {
  if (!Number.isFinite(radius) || radius < 60 || radius > 300 || !Number.isFinite(amount) || amount <= 0 || amount > 3 || !['raise', 'lower', 'restore'].includes(tool)) return field;
  const z = [...field.heights];
  let changed = false;
  for (const p of centers) {
    if (!insideTerrain(p)) continue;
    const x0 = Math.max(1, Math.ceil((p.x - radius - TERRAIN.x) / TERRAIN.cell));
    const x1 = Math.min(TERRAIN.cols - 2, Math.floor((p.x + radius - TERRAIN.x) / TERRAIN.cell));
    const y0 = Math.max(1, Math.ceil((p.y - radius - TERRAIN.y) / TERRAIN.cell));
    const y1 = Math.min(TERRAIN.rows - 2, Math.floor((p.y + radius - TERRAIN.y) / TERRAIN.cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(TERRAIN.x + x * TERRAIN.cell - p.x, TERRAIN.y + y * TERRAIN.cell - p.y) / radius;
      if (d >= 1) continue;
      const weight = (1 - d * d) ** 2, i = y * TERRAIN.cols + x, before = z[i];
      const delta = amount * weight;
      z[i] = tool === 'restore' ? Math.sign(before) * Math.max(0, Math.abs(before) - delta) :
        Math.max(-TERRAIN.limit, Math.min(TERRAIN.limit, before + (tool === 'raise' ? delta : -delta)));
      changed ||= z[i] !== before;
    }
  }
  return changed ? { heights: z } : field;
}

/** Keep per-stroke painting independent of pointer event frequency. */
export class TerrainStroke {
  private last: Point;
  private remaining: number;
  constructor(start: Point, readonly spacing: number) { this.last = start; this.remaining = spacing; }
  move(to: Point): Point[] {
    const from = this.last, distance = Math.hypot(to.x - from.x, to.y - from.y), result: Point[] = [];
    if (distance > 0) {
      let along = this.remaining;
      for (; along <= distance; along += this.spacing) result.push({ x: from.x + (to.x - from.x) * along / distance, y: from.y + (to.y - from.y) * along / distance });
      this.remaining = along - distance;
    }
    this.last = to;
    return result;
  }
}

export function validTerrain(value: unknown): value is TerrainField {
  if (!value || typeof value !== 'object' || !('heights' in value) || !Array.isArray(value.heights)) return false;
  return value.heights.length === TERRAIN.cols * TERRAIN.rows && value.heights.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= TERRAIN.limit);
}

/** Reject shortcuts over a raised neck; no flood-level or water-volume solver. */
export function terrainAllowsCutoff(field: TerrainField, a: Point, b: Point, headroom: number): boolean {
  const limit = Math.max(reliefAt(field, a), reliefAt(field, b)) + headroom;
  const count = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let j = 1; j < count; j++) {
    if (reliefAt(field, { x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count }) > limit) return false;
  }
  return true;
}

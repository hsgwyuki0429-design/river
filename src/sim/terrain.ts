/**
 * 地形生成。
 *
 * ステージ定義から地形をつくるための宣言的な操作リスト。
 * 座標はすべて 0..1 の正規化座標なので、端末性能に応じて格子解像度を変えても
 * 同じ地形が再現できる。
 */

import type { TerrainGrid } from './grid.ts';
import { fbm } from './rng.ts';

export type TerrainOp =
  /** 全体を一定の高さにする */
  | { type: 'flat'; height: number }
  /** 一方向に傾いた斜面。dir は高い側から低い側への向き */
  | { type: 'slope'; high: number; low: number; dir: 'down' | 'up' | 'right' | 'left' }
  /** フラクタルノイズを加える */
  | { type: 'noise'; amplitude: number; scale: number; seed: number; octaves?: number }
  /** 円錐状の丘（負の height で窪み） */
  | { type: 'hill'; x: number; y: number; radius: number; height: number }
  /** 矩形の台地。blend で縁のぼかし幅（正規化） */
  | { type: 'plateau'; x: number; y: number; w: number; h: number; height: number; blend?: number }
  /** 矩形を指定の高さまで掘り下げる（既存より高い場合のみ下げる） */
  | { type: 'carve'; x: number; y: number; w: number; h: number; height: number; blend?: number }
  /** 折れ線に沿った溝（depth>0 で掘る） */
  | { type: 'channel'; points: [number, number][]; width: number; depth: number }
  /** 折れ線に沿った堤（height>0 で盛る） */
  | { type: 'levee'; points: [number, number][]; width: number; height: number }
  /** 初期の水（水位 level まで満たす。地盤より低ければ何もしない） */
  | { type: 'water'; x: number; y: number; w: number; h: number; level: number }
  /** 岩盤（削れない領域）。bedrock は地盤の下限高さ */
  | { type: 'rock'; x: number; y: number; w: number; h: number; erodibility?: number }
  /** 削れやすさの上書き */
  | { type: 'erodibility'; x: number; y: number; w: number; h: number; value: number }
  /** 排水口（水を盤面外へ捨てる） */
  | { type: 'drain'; x: number; y: number; w: number; h: number };

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineDistance(px: number, py: number, points: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = segmentDistance(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

/** 矩形内でのなめらかな重み（blend は縁のぼかし幅） */
function rectWeight(
  u: number,
  v: number,
  x: number,
  y: number,
  w: number,
  h: number,
  blend: number,
): number {
  if (blend <= 0) return u >= x && u <= x + w && v >= y && v <= y + h ? 1 : 0;
  const dx = Math.min(u - x, x + w - u);
  const dy = Math.min(v - y, y + h - v);
  const d = Math.min(dx, dy);
  if (d <= -blend) return 0;
  const t = Math.max(0, Math.min(1, (d + blend) / (2 * blend)));
  return t * t * (3 - 2 * t);
}

/** 地形操作を順に適用する。bedrock / erodibility / drain / 初期水も設定される */
export function applyTerrainOps(grid: TerrainGrid, ops: TerrainOp[]): void {
  const { width, height } = grid;
  const bed = grid.bedHeight;

  for (const op of ops) {
    switch (op.type) {
      case 'flat':
        bed.fill(op.height);
        break;

      case 'slope': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = width > 1 ? x / (width - 1) : 0;
            const v = height > 1 ? y / (height - 1) : 0;
            let t: number;
            if (op.dir === 'down') t = v;
            else if (op.dir === 'up') t = 1 - v;
            else if (op.dir === 'right') t = u;
            else t = 1 - u;
            bed[y * width + x] = op.high + (op.low - op.high) * t;
          }
        }
        break;
      }

      case 'noise': {
        const n = fbm(op.seed, op.octaves ?? 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = (x / width) * op.scale;
            const v = (y / height) * op.scale;
            bed[y * width + x] += n(u, v) * op.amplitude;
          }
        }
        break;
      }

      case 'hill': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = x / width;
            const v = y / height;
            const dx = u - op.x;
            const dy = v - op.y;
            const d = Math.sqrt(dx * dx + dy * dy) / op.radius;
            if (d >= 1) continue;
            const t = 1 - d;
            bed[y * width + x] += op.height * t * t * (3 - 2 * t);
          }
        }
        break;
      }

      case 'plateau': {
        const blend = op.blend ?? 0.02;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const w = rectWeight(x / width, y / height, op.x, op.y, op.w, op.h, blend);
            if (w > 0) bed[y * width + x] += op.height * w;
          }
        }
        break;
      }

      case 'carve': {
        const blend = op.blend ?? 0.02;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const w = rectWeight(x / width, y / height, op.x, op.y, op.w, op.h, blend);
            if (w <= 0) continue;
            const i = y * width + x;
            if (bed[i] > op.height) bed[i] += (op.height - bed[i]) * w;
          }
        }
        break;
      }

      case 'channel': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const d = polylineDistance(x / width, y / height, op.points);
            if (d >= op.width) continue;
            const t = 1 - d / op.width;
            bed[y * width + x] -= op.depth * t * t * (3 - 2 * t);
          }
        }
        break;
      }

      case 'levee': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const d = polylineDistance(x / width, y / height, op.points);
            if (d >= op.width) continue;
            const t = 1 - d / op.width;
            bed[y * width + x] += op.height * t * t * (3 - 2 * t);
          }
        }
        break;
      }

      case 'water': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = x / width;
            const v = y / height;
            if (u < op.x || u > op.x + op.w || v < op.y || v > op.y + op.h) continue;
            const i = y * width + x;
            const d = op.level - bed[i];
            if (d > 0) grid.waterDepth[i] = d;
          }
        }
        break;
      }

      case 'rock': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = x / width;
            const v = y / height;
            if (u < op.x || u > op.x + op.w || v < op.y || v > op.y + op.h) continue;
            const i = y * width + x;
            grid.bedrockHeight[i] = bed[i];
            grid.erodibility[i] = op.erodibility ?? 0;
          }
        }
        break;
      }

      case 'erodibility': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = x / width;
            const v = y / height;
            if (u < op.x || u > op.x + op.w || v < op.y || v > op.y + op.h) continue;
            grid.erodibility[y * width + x] = op.value;
          }
        }
        break;
      }

      case 'drain': {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const u = x / width;
            const v = y / height;
            if (u < op.x || u > op.x + op.w || v < op.y || v > op.y + op.h) continue;
            grid.drain[y * width + x] = 1;
          }
        }
        break;
      }
    }
  }

  // 地盤が岩盤より低くならないように整える
  for (let i = 0; i < grid.size; i++) {
    if (bed[i] < grid.bedrockHeight[i]) bed[i] = grid.bedrockHeight[i];
    if (!Number.isFinite(bed[i])) bed[i] = 0;
  }
}

/**
 * 描画用の色計算。
 *
 * シミュレーション状態（計算用データ）から、画面に出す色（描画用データ）へ
 * 変換するだけのモジュール。ここでシミュレーション状態は書き換えない。
 *
 * 区別する対象:
 *   乾いた砂 / 濡れた砂 / 浅い水 / 深い水 / 流れの速い水 /
 *   濁った水 / 侵食中 / 堆積中
 */

import type { TerrainGrid } from '../sim/grid.ts';

export type DebugLayer =
  | 'none'
  | 'height'
  | 'depth'
  | 'velocity'
  | 'sediment'
  | 'erosion'
  | 'deposition';

export interface PaintOptions {
  /** 濡れ始めとみなす水深 [m] */
  dampDepth: number;
  /** 「深い水」とみなす水深 [m] */
  deepDepth: number;
  /** 濃度の正規化基準 */
  maxConcentration: number;
  /** 速い流れとみなす流速 [m/s] */
  fastSpeed: number;
  debugLayer: DebugLayer;
  /** 標高の表示レンジ */
  minBed: number;
  maxBed: number;
  /** 等高線の間隔 [m]。0 で非表示 */
  contourStep: number;
}

/** 1セル分の状態（描画に必要な値だけを取り出したもの） */
export interface CellSample {
  bed: number;
  depth: number;
  sediment: number;
  speed: number;
  erosion: number;
  deposition: number;
  /** 陰影 (平坦で 0.707) */
  shade: number;
}

/** 0..1 を青→緑→赤のカラーマップへ */
function heatColor(t: number, out: Uint8ClampedArray, off: number): void {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  if (x < 0.5) {
    const u = x * 2;
    out[off] = 20 + u * 60;
    out[off + 1] = 60 + u * 170;
    out[off + 2] = 180 - u * 60;
  } else {
    const u = (x - 0.5) * 2;
    out[off] = 80 + u * 175;
    out[off + 1] = 230 - u * 150;
    out[off + 2] = 120 - u * 90;
  }
  out[off + 3] = 255;
}

/** 陰影の誇張倍率。実地形の傾きは小さいので、見やすさのため強調する */
export const SHADE_EXAGGERATION = 5;

/** サンプル値から色を決める */
export function paintSample(s: CellSample, opt: PaintOptions, out: Uint8ClampedArray, off: number): void {
  if (opt.debugLayer !== 'none') {
    let t = 0;
    switch (opt.debugLayer) {
      case 'height':
        t = (s.bed - opt.minBed) / Math.max(1e-6, opt.maxBed - opt.minBed);
        break;
      case 'depth':
        t = s.depth / 0.6;
        break;
      case 'velocity':
        t = s.speed / 3;
        break;
      case 'sediment':
        t = s.sediment / 0.05;
        break;
      case 'erosion':
        t = s.erosion / 0.02;
        break;
      case 'deposition':
        t = s.deposition / 0.02;
        break;
    }
    heatColor(t, out, off);
    return;
  }

  const depth = s.depth;
  const elev = (s.bed - opt.minBed) / Math.max(1e-6, opt.maxBed - opt.minBed);

  // --- 乾いた砂（標高で色味が変わる） ---
  let r = 150 + elev * 88;
  let g = 128 + elev * 80;
  let b = 96 + elev * 58;

  // --- 濡れた砂 ---
  if (depth > 0) {
    const wet = Math.min(1, depth / opt.dampDepth);
    r += (104 - r) * wet * 0.6;
    g += (86 - g) * wet * 0.6;
    b += (64 - b) * wet * 0.6;
  }

  // --- 陰影（bedHeight の勾配そのもの。地形が削れれば見た目もすぐ変わる） ---
  const sh = 0.42 + s.shade * 0.82;
  r *= sh;
  g *= sh;
  b *= sh;

  // --- 等高線（高低差を読み取りやすくする） ---
  if (opt.contourStep > 0 && depth < opt.dampDepth) {
    const c = s.bed / opt.contourStep;
    const f = c - Math.floor(c);
    const d = f < 0.5 ? f : 1 - f;
    if (d < 0.055) {
      const k = (1 - d / 0.055) * 0.22;
      r *= 1 - k;
      g *= 1 - k;
      b *= 1 - k;
    }
  }

  // --- 侵食中／堆積中 ---
  if (s.erosion > 1e-5) {
    const t = Math.min(1, s.erosion / 0.012) * 0.55;
    r += (214 - r) * t;
    g += (86 - g) * t;
    b += (72 - b) * t;
  }
  if (s.deposition > 1e-5) {
    const t = Math.min(1, s.deposition / 0.012) * 0.5;
    r += (250 - r) * t;
    g += (216 - g) * t;
    b += (112 - b) * t;
  }

  // --- 水 ---
  if (depth > opt.dampDepth * 0.5) {
    const dt = Math.min(1, depth / opt.deepDepth);
    let wr = 92 + (18 - 92) * dt;
    let wg = 178 + (62 - 178) * dt;
    let wb = 186 + (124 - 186) * dt;

    // 濁り（浮遊土砂）
    const conc = depth > 1e-4 ? s.sediment / depth : 0;
    const turb = Math.min(1, conc / Math.max(1e-6, opt.maxConcentration));
    if (turb > 0) {
      wr += (170 - wr) * turb * 0.85;
      wg += (142 - wg) * turb * 0.85;
      wb += (96 - wb) * turb * 0.85;
    }

    // 速い流れは白く泡立つ
    if (s.speed > opt.fastSpeed) {
      const t = Math.min(1, (s.speed - opt.fastSpeed) / (opt.fastSpeed * 2)) * 0.55;
      wr += (238 - wr) * t;
      wg += (246 - wg) * t;
      wb += (250 - wb) * t;
    }

    // 浅いほど地面が透ける
    const alpha = 0.32 + 0.68 * Math.min(1, depth / (opt.deepDepth * 0.6));
    r += (wr - r) * alpha;
    g += (wg - g) * alpha;
    b += (wb - b) * alpha;
  }

  out[off] = r;
  out[off + 1] = g;
  out[off + 2] = b;
  out[off + 3] = 255;
}

const sample: CellSample = {
  bed: 0,
  depth: 0,
  sediment: 0,
  speed: 0,
  erosion: 0,
  deposition: 0,
  shade: 0.707,
};

/** セル単位で色を決める（斜めビュー用） */
export function cellColor(
  grid: TerrainGrid,
  i: number,
  shade: number,
  opt: PaintOptions,
  out: Uint8ClampedArray,
  off: number,
): void {
  const vx = grid.velocityX[i];
  const vy = grid.velocityY[i];
  sample.bed = grid.bedHeight[i];
  sample.depth = grid.waterDepth[i];
  sample.sediment = grid.suspendedSediment[i];
  sample.speed = Math.sqrt(vx * vx + vy * vy);
  sample.erosion = grid.erosionRecent[i];
  sample.deposition = grid.depositionRecent[i];
  sample.shade = shade;
  paintSample(sample, opt, out, off);
}

/**
 * セルごとの陰影を計算して配列に書き出す。
 * 実地形の傾きは小さいので SHADE_EXAGGERATION で強調する。
 */
export function computeShadeMap(grid: TerrainGrid, cellSize: number, out: Float32Array): void {
  const { width, height } = grid;
  const bed = grid.bedHeight;
  const k = SHADE_EXAGGERATION / (2 * cellSize);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const xm = x > 0 ? i - 1 : i;
      const xp = x < width - 1 ? i + 1 : i;
      const ym = y > 0 ? i - width : i;
      const yp = y < height - 1 ? i + width : i;
      // 面法線 N = (nx, ny, 1) / |…|、光源 L = (-0.5, -0.5, 0.707)
      const nx = (bed[xm] - bed[xp]) * k;
      const ny = (bed[ym] - bed[yp]) * k;
      const l = (nx * -0.5 + ny * -0.5 + 0.707) / Math.sqrt(nx * nx + ny * ny + 1);
      out[i] = l < 0 ? 0 : l > 1 ? 1 : l;
    }
  }
}

/** 標高レンジから見やすい等高線間隔を選ぶ */
export function chooseContourStep(range: number): number {
  const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 5];
  const target = range / 14;
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - target) < Math.abs(best - target)) best = c;
  }
  return best;
}

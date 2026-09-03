/**
 * 描画。シミュレーション状態を読むだけで、書き換えはしない。
 *
 * - 真上ビュー: 1セル1ピクセルのImageDataを作り、キャンバスへ拡大転送する
 * - 斜めビュー: 高さ場をボクセル風に投影し、高低差を確認できるようにする
 *
 * 描画とシミュレーションは別々の頻度で更新できる（render() は好きな時に呼べる）。
 */

import type { Simulation } from '../sim/simulation.ts';
import type { TerrainGrid } from '../sim/grid.ts';
import type { Zone } from '../game/stage.ts';
import {
  cellColor,
  chooseContourStep,
  computeShadeMap,
  paintSample,
  type CellSample,
  type DebugLayer,
  type PaintOptions,
} from './palette.ts';

export type ViewMode = 'top' | 'oblique';

export interface Camera {
  /** 表示倍率 */
  zoom: number;
  /** 平行移動 [CSSピクセル] */
  offsetX: number;
  offsetY: number;
}

export interface RenderOptions {
  view: ViewMode;
  debugLayer: DebugLayer;
  showVelocity: boolean;
  zones: Zone[];
  /** ブラシカーソル（セル座標）。null で非表示 */
  brush: { x: number; y: number; radius: number; mode: 'raise' | 'lower' } | null;
  sources: { x: number; y: number; radius: number }[];
}

const OBLIQUE_Y_SCALE = 0.8;
const OBLIQUE_HEIGHT_SCALE = 9;
const OBLIQUE_SUB_X = 3;

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private imageW = 0;
  private imageH = 0;
  /** 斜めビューのピッキング用（画面ピクセル → セル番号） */
  private pickBuffer: Int32Array = new Int32Array(0);
  private pickW = 0;
  private pickH = 0;

  /** 真上ビューの拡大率（1セルを何ピクセルで描くか）。負荷に応じて下げられる */
  superSample = 2;
  private shadeMap = new Float32Array(0);

  camera: Camera = { zoom: 1, offsetX: 0, offsetY: 0 };
  /** HUD やツールバーに隠れないように確保する余白 [CSSピクセル] */
  insets = { top: 0, bottom: 0, left: 0, right: 0 };
  /** 盤面をキャンバスへ収めるための基準スケール */
  private baseScale = 1;
  private baseX = 0;
  private baseY = 0;
  private lastView: ViewMode = 'top';
  private dpr = 1;
  private lastGrid: TerrainGrid | null = null;
  private lastMinBed = 0;
  private lastHeightSpan = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;
    this.buffer = document.createElement('canvas');
    const bctx = this.buffer.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!bctx) throw new Error('バッファの 2D コンテキストを取得できませんでした');
    this.bctx = bctx;
  }

  /** キャンバスの表示サイズを設定（端末のピクセル比を考慮） */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  get cssWidth(): number {
    return this.canvas.width / this.dpr;
  }
  get cssHeight(): number {
    return this.canvas.height / this.dpr;
  }

  private ensureBuffer(w: number, h: number): void {
    if (this.imageW !== w || this.imageH !== h || !this.image) {
      this.buffer.width = w;
      this.buffer.height = h;
      this.image = this.bctx.createImageData(w, h);
      this.imageW = w;
      this.imageH = h;
    }
  }

  render(sim: Simulation, opt: RenderOptions): void {
    const g = sim.grid;
    let minBed = Infinity;
    let maxBed = -Infinity;
    for (let i = 0; i < g.size; i++) {
      const b = g.bedHeight[i];
      if (b < minBed) minBed = b;
      if (b > maxBed) maxBed = b;
    }
    if (!(maxBed > minBed)) maxBed = minBed + 1;

    const paint: PaintOptions = {
      dampDepth: 0.035,
      deepDepth: 0.45,
      maxConcentration: sim.params.maxConcentration,
      fastSpeed: 1.1,
      debugLayer: opt.debugLayer,
      minBed,
      maxBed,
      contourStep: opt.debugLayer === 'none' ? chooseContourStep(maxBed - minBed) : 0,
    };

    if (this.shadeMap.length !== g.size) this.shadeMap = new Float32Array(g.size);
    computeShadeMap(g, sim.params.cellSize, this.shadeMap);

    this.lastGrid = g;
    this.lastMinBed = minBed;
    if (opt.view === 'top') this.renderTop(sim, paint);
    else this.renderOblique(sim, paint);

    this.lastView = opt.view;
    this.blit(opt);
    this.drawOverlays(sim, opt);
  }

  // ------------------------------------------------------------ 真上

  private renderTop(sim: Simulation, paint: PaintOptions): void {
    const g = sim.grid;
    const S = Math.max(1, Math.round(this.superSample));
    const bw = g.width * S;
    const bh = g.height * S;
    this.ensureBuffer(bw, bh);
    const img = this.image!;
    const data = img.data;
    const shadeMap = this.shadeMap;
    const w = g.width;
    const h = g.height;
    const invS = 1 / S;
    const smp: CellSample = {
      bed: 0,
      depth: 0,
      sediment: 0,
      speed: 0,
      erosion: 0,
      deposition: 0,
      shade: 0.707,
    };

    for (let oy = 0; oy < bh; oy++) {
      const gy = (oy + 0.5) * invS - 0.5;
      let y0 = Math.floor(gy);
      const fy = gy - y0;
      if (y0 < 0) y0 = 0;
      const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
      const r0 = y0 * w;
      const r1 = y1 * w;
      for (let ox = 0; ox < bw; ox++) {
        const gx = (ox + 0.5) * invS - 0.5;
        let x0 = Math.floor(gx);
        const fx = gx - x0;
        if (x0 < 0) x0 = 0;
        const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
        const i00 = r0 + x0;
        const i10 = r0 + x1;
        const i01 = r1 + x0;
        const i11 = r1 + x1;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        smp.bed =
          g.bedHeight[i00] * w00 +
          g.bedHeight[i10] * w10 +
          g.bedHeight[i01] * w01 +
          g.bedHeight[i11] * w11;
        smp.depth =
          g.waterDepth[i00] * w00 +
          g.waterDepth[i10] * w10 +
          g.waterDepth[i01] * w01 +
          g.waterDepth[i11] * w11;
        smp.sediment =
          g.suspendedSediment[i00] * w00 +
          g.suspendedSediment[i10] * w10 +
          g.suspendedSediment[i01] * w01 +
          g.suspendedSediment[i11] * w11;
        const vx =
          g.velocityX[i00] * w00 +
          g.velocityX[i10] * w10 +
          g.velocityX[i01] * w01 +
          g.velocityX[i11] * w11;
        const vy =
          g.velocityY[i00] * w00 +
          g.velocityY[i10] * w10 +
          g.velocityY[i01] * w01 +
          g.velocityY[i11] * w11;
        smp.speed = Math.sqrt(vx * vx + vy * vy);
        smp.erosion =
          g.erosionRecent[i00] * w00 +
          g.erosionRecent[i10] * w10 +
          g.erosionRecent[i01] * w01 +
          g.erosionRecent[i11] * w11;
        smp.deposition =
          g.depositionRecent[i00] * w00 +
          g.depositionRecent[i10] * w10 +
          g.depositionRecent[i01] * w01 +
          g.depositionRecent[i11] * w11;
        smp.shade =
          shadeMap[i00] * w00 + shadeMap[i10] * w10 + shadeMap[i01] * w01 + shadeMap[i11] * w11;

        paintSample(smp, paint, data, (oy * bw + ox) * 4);
      }
    }
    this.bctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------ 斜め

  private renderOblique(sim: Simulation, paint: PaintOptions): void {
    const g = sim.grid;
    const bw = g.width * OBLIQUE_SUB_X;
    const heightSpan = (paint.maxBed - paint.minBed) * OBLIQUE_HEIGHT_SCALE + 8;
    this.lastHeightSpan = heightSpan;
    const bh = Math.round(g.height * OBLIQUE_Y_SCALE + heightSpan);
    this.ensureBuffer(bw, bh);
    const img = this.image!;
    const data = img.data;

    // 背景
    for (let p = 0; p < data.length; p += 4) {
      data[p] = 24;
      data[p + 1] = 28;
      data[p + 2] = 36;
      data[p + 3] = 255;
    }
    if (this.pickW !== bw || this.pickH !== bh) {
      this.pickBuffer = new Int32Array(bw * bh);
      this.pickW = bw;
      this.pickH = bh;
    }
    this.pickBuffer.fill(-1);

    const yMin = new Int32Array(bw).fill(bh);
    const color = new Uint8ClampedArray(4);

    // 手前（y大）から奥（y小）へ。各列で未描画の部分だけ塗る
    for (let y = g.height - 1; y >= 0; y--) {
      const rowBase = y * OBLIQUE_Y_SCALE + heightSpan;
      for (let x = 0; x < g.width; x++) {
        const i = y * g.width + x;
        const surface = g.bedHeight[i] + Math.max(0, g.waterDepth[i]);
        const top = Math.round(rowBase - (surface - paint.minBed) * OBLIQUE_HEIGHT_SCALE);
        const bx0 = x * OBLIQUE_SUB_X;
        for (let sx = 0; sx < OBLIQUE_SUB_X; sx++) {
          const bx = bx0 + sx;
          let limit = yMin[bx];
          if (top >= limit) continue;
          const start = top < 0 ? 0 : top;
          if (limit > bh) limit = bh;
          if (start >= limit) {
            if (top < yMin[bx]) yMin[bx] = top;
            continue;
          }
          cellColor(g, i, this.shadeMap[i], paint, color, 0);
          for (let py = start; py < limit; py++) {
            const p = (py * bw + bx) * 4;
            // 下へ行くほど暗くして側面を表現する
            const k = py === start ? 1 : Math.max(0.45, 1 - (py - start) * 0.05);
            data[p] = color[0] * k;
            data[p + 1] = color[1] * k;
            data[p + 2] = color[2] * k;
            data[p + 3] = 255;
            this.pickBuffer[py * bw + bx] = i;
          }
          yMin[bx] = top;
        }
      }
    }
    this.bctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------- 画面へ転送

  private blit(opt: RenderOptions): void {
    const ctx = this.ctx;
    const cw = this.cssWidth;
    const ch = this.cssHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#13161d';
    ctx.fillRect(0, 0, cw, ch);

    const bw = this.imageW;
    const bh = this.imageH;
    const ins = this.insets;
    const availW = Math.max(40, cw - ins.left - ins.right);
    const availH = Math.max(40, ch - ins.top - ins.bottom);
    const scale = Math.min(availW / bw, availH / bh);
    this.baseScale = scale;
    this.baseX = ins.left + (availW - bw * scale) / 2;
    this.baseY = ins.top + (availH - bh * scale) / 2;

    const z = this.camera.zoom;
    ctx.imageSmoothingEnabled = opt.debugLayer === 'none';
    ctx.drawImage(
      this.buffer,
      this.baseX + this.camera.offsetX,
      this.baseY + this.camera.offsetY,
      bw * scale * z,
      bh * scale * z,
    );
  }

  // ---------------------------------------------------------- オーバーレイ

  private drawOverlays(sim: Simulation, opt: RenderOptions): void {
    const ctx = this.ctx;
    const g = sim.grid;

    // 区域（ゴール／浸水禁止／堆積目標／排水口）
    for (const zone of opt.zones) {
      const p0 = this.cellToScreen(zone.rect.x * g.width, zone.rect.y * g.height);
      const p1 = this.cellToScreen(
        (zone.rect.x + zone.rect.w) * g.width,
        (zone.rect.y + zone.rect.h) * g.height,
      );
      const style =
        zone.kind === 'goal'
          ? { stroke: '#48d19a', fill: 'rgba(72,209,154,0.14)' }
          : zone.kind === 'protected'
            ? { stroke: '#ff5d5d', fill: 'rgba(255,93,93,0.18)' }
            : zone.kind === 'deposit'
              ? { stroke: '#f0c04a', fill: 'rgba(240,192,74,0.14)' }
              : zone.kind === 'drain'
                ? { stroke: '#7aa7ff', fill: 'rgba(122,167,255,0.14)' }
                : { stroke: '#9fd8ff', fill: 'rgba(159,216,255,0.10)' };
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = 2;
      ctx.setLineDash(zone.kind === 'protected' ? [6, 4] : []);
      ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx.setLineDash([]);
      ctx.fillStyle = style.stroke;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(zone.label, p0.x + 4, Math.max(12, p0.y - 4));
    }

    // 水源
    for (const s of opt.sources) {
      const p = this.cellToScreen(s.x, s.y);
      ctx.strokeStyle = '#8fe4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(8, s.radius * this.pixelsPerCell()), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(143,228,255,0.25)';
      ctx.fill();
    }

    // 流速ベクトル（デバッグ）
    if (opt.showVelocity) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = Math.max(3, Math.round(g.width / 28));
      for (let y = 0; y < g.height; y += step) {
        for (let x = 0; x < g.width; x += step) {
          const i = y * g.width + x;
          if (g.waterDepth[i] < 0.01) continue;
          const vx = g.velocityX[i];
          const vy = g.velocityY[i];
          const sp = Math.sqrt(vx * vx + vy * vy);
          if (sp < 0.05) continue;
          const p = this.cellToScreen(x + 0.5, y + 0.5);
          const k = (Math.min(sp, 3) / 3) * step * this.pixelsPerCell() * 0.9;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + (vx / sp) * k, p.y + (vy / sp) * k);
        }
      }
      ctx.stroke();
    }

    // ブラシ
    if (opt.brush) {
      const p = this.cellToScreen(opt.brush.x, opt.brush.y);
      const r = opt.brush.radius * this.pixelsPerCell();
      ctx.strokeStyle = opt.brush.mode === 'raise' ? '#ffd479' : '#7fd4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, r), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** 1セルあたりの画面ピクセル数（おおよそ） */
  private pixelsPerCell(): number {
    const sub = this.lastView === 'oblique' ? OBLIQUE_SUB_X : Math.max(1, Math.round(this.superSample));
    return this.baseScale * this.camera.zoom * sub;
  }

  /** セル座標 → 画面座標（CSSピクセル） */
  cellToScreen(cx: number, cy: number): { x: number; y: number } {
    const z = this.camera.zoom;
    const S = Math.max(1, Math.round(this.superSample));
    let bx = cx * S;
    let by = cy * S;
    if (this.lastView === 'oblique') {
      bx = cx * OBLIQUE_SUB_X;
      let h = this.lastMinBed;
      const g = this.lastGrid;
      if (g) {
        const xi = Math.max(0, Math.min(g.width - 1, Math.floor(cx)));
        const yi = Math.max(0, Math.min(g.height - 1, Math.floor(cy)));
        const i = yi * g.width + xi;
        h = g.bedHeight[i] + Math.max(0, g.waterDepth[i]);
      }
      by =
        cy * OBLIQUE_Y_SCALE +
        this.lastHeightSpan -
        (h - this.lastMinBed) * OBLIQUE_HEIGHT_SCALE;
    }
    return {
      x: this.baseX + this.camera.offsetX + bx * this.baseScale * z,
      y: this.baseY + this.camera.offsetY + by * this.baseScale * z,
    };
  }

  /**
   * 画面座標 → セル座標。斜めビューでは描画時のピッキングバッファを使うので、
   * 見えている地形をそのまま拾える。
   */
  screenToCell(sx: number, sy: number): { x: number; y: number } | null {
    const z = this.camera.zoom;
    const bx = (sx - this.baseX - this.camera.offsetX) / (this.baseScale * z);
    const by = (sy - this.baseY - this.camera.offsetY) / (this.baseScale * z);
    if (this.lastView === 'oblique') {
      const px = Math.round(bx);
      const py = Math.round(by);
      if (px < 0 || py < 0 || px >= this.pickW || py >= this.pickH) return null;
      const idx = this.pickBuffer[py * this.pickW + px];
      if (idx < 0) return null;
      const w = this.imageW / OBLIQUE_SUB_X;
      return { x: (idx % w) + 0.5, y: Math.floor(idx / w) + 0.5 };
    }
    if (bx < 0 || by < 0 || bx >= this.imageW || by >= this.imageH) return null;
    const S = Math.max(1, Math.round(this.superSample));
    return { x: bx / S, y: by / S };
  }
}

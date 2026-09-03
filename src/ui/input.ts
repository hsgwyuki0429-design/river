/**
 * 盤面のタッチ／マウス操作。
 *
 * ジェスチャーの切り分け:
 *   - 指1本のドラッグ  → 砂を盛る／削る（地形編集）
 *   - 指2本            → 視点の移動と拡大縮小（編集は即座に中断する）
 *   - 「視点移動」ツール選択中は指1本でも視点移動
 *
 * 1本目の指が触れてから短い猶予（GESTURE_DELAY）を置いてから編集を始めるので、
 * 2本指のピンチを地形編集と誤認しない。
 * 猶予内に指が離れた場合はタップとして1回だけ編集する。
 */

import type { Renderer } from '../render/renderer.ts';
import type { Session } from '../game/session.ts';

/** 2本指かどうかを見極めるための猶予 [ms] */
const GESTURE_DELAY = 70;
/** 猶予中でも動かし始めたら編集とみなす距離 [CSSピクセル] */
const MOVE_THRESHOLD = 5;
/** 中心での基本の変化速度 [m/s] */
const BASE_EDIT_RATE = 1.2;
/** 長押しでどこまで増えるか */
const MAX_DWELL_GAIN = 2.5;
/** 同じ場所とみなす距離 [セル] */
const DWELL_RADIUS = 1.5;

export interface BrushCursor {
  x: number;
  y: number;
  radius: number;
  mode: 'raise' | 'lower';
}

export class BoardInput {
  private pointers = new Map<number, { x: number; y: number }>();
  private editing = false;
  private armed = false;
  private armedAt = 0;
  private armedPos = { x: 0, y: 0 };
  private cell: { x: number; y: number } | null = null;
  private dwell = 0;
  private pinch: {
    dist: number;
    midX: number;
    midY: number;
    zoom: number;
    offX: number;
    offY: number;
  } | null = null;

  /** 画面に出すブラシカーソル */
  cursor: BrushCursor | null = null;
  /** 砂が足りないときに呼ばれる */
  onOutOfSand: (() => void) | null = null;
  /** 設定されている間は編集せず、タップ位置を通知するだけにする（水源の移動など） */
  interceptTap: ((cell: { x: number; y: number }) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: Renderer,
    private session: Session,
  ) {
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove, { passive: false });
    canvas.addEventListener('pointerup', this.onUp, { passive: false });
    canvas.addEventListener('pointercancel', this.onUp, { passive: false });
    canvas.addEventListener('pointerleave', this.onUp, { passive: false });
    // iOS のダブルタップ拡大とスクロールを止める
    canvas.addEventListener('touchstart', preventDefault, { passive: false });
    canvas.addEventListener('touchmove', preventDefault, { passive: false });
    canvas.addEventListener('dblclick', preventDefault);
    canvas.addEventListener('contextmenu', preventDefault);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 1) {
      if (this.interceptTap) {
        const cell = this.renderer.screenToCell(p.x, p.y);
        if (cell) {
          const cb = this.interceptTap;
          this.interceptTap = null;
          cb(cell);
        }
        return;
      }
      if (this.session.tool === 'camera') {
        this.startPan(p);
      } else {
        this.armed = true;
        this.armedAt = performance.now();
        this.armedPos = p;
        this.cell = this.renderer.screenToCell(p.x, p.y);
        this.updateCursor();
      }
    } else if (this.pointers.size === 2) {
      // 2本指になった時点で編集は中断する
      this.editing = false;
      this.armed = false;
      this.cursor = null;
      this.startPinch();
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId)!;
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }

    if (this.session.tool === 'camera') {
      this.renderer.camera.offsetX += p.x - prev.x;
      this.renderer.camera.offsetY += p.y - prev.y;
      this.clampCamera();
      return;
    }

    if (this.armed) {
      const dx = p.x - this.armedPos.x;
      const dy = p.y - this.armedPos.y;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD || performance.now() - this.armedAt > GESTURE_DELAY) {
        this.armed = false;
        this.editing = true;
        this.dwell = 0;
      }
    }

    const next = this.renderer.screenToCell(p.x, p.y);
    if (next) {
      if (this.cell && Math.hypot(next.x - this.cell.x, next.y - this.cell.y) > DWELL_RADIUS) {
        this.dwell = 0;
      }
      this.cell = next;
    }
    this.updateCursor();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.canvas.releasePointerCapture?.(e.pointerId);

    if (this.armed && this.pointers.size === 0) {
      // 短いタップ: 1回だけ編集する
      this.armed = false;
      this.applyEdit(0.12);
    }
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.editing = false;
      this.armed = false;
      this.dwell = 0;
      this.cursor = null;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const cam = this.renderer.camera;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const before = cam.zoom;
    const next = Math.max(0.6, Math.min(4, cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const k = next / before;
    cam.offsetX = mx - (mx - cam.offsetX) * k;
    cam.offsetY = my - (my - cam.offsetY) * k;
    cam.zoom = next;
    this.clampCamera();
  };

  private startPan(_p: { x: number; y: number }): void {
    this.editing = false;
    this.armed = false;
    this.cursor = null;
  }

  private startPinch(): void {
    const [a, b] = Array.from(this.pointers.values());
    const cam = this.renderer.camera;
    this.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      zoom: cam.zoom,
      offX: cam.offsetX,
      offY: cam.offsetY,
    };
  }

  private updatePinch(): void {
    if (!this.pinch) return;
    const [a, b] = Array.from(this.pointers.values());
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const cam = this.renderer.camera;
    const scale = this.pinch.dist > 4 ? dist / this.pinch.dist : 1;
    const zoom = Math.max(0.6, Math.min(4, this.pinch.zoom * scale));
    const k = zoom / this.pinch.zoom;
    cam.zoom = zoom;
    cam.offsetX = midX - (this.pinch.midX - this.pinch.offX) * k;
    cam.offsetY = midY - (this.pinch.midY - this.pinch.offY) * k;
    this.clampCamera();
  }

  private clampCamera(): void {
    const cam = this.renderer.camera;
    const w = this.renderer.cssWidth;
    const h = this.renderer.cssHeight;
    const limit = 0.9;
    cam.offsetX = Math.max(-w * limit, Math.min(w * limit, cam.offsetX));
    cam.offsetY = Math.max(-h * limit, Math.min(h * limit, cam.offsetY));
  }

  resetCamera(): void {
    this.renderer.camera.zoom = 1;
    this.renderer.camera.offsetX = 0;
    this.renderer.camera.offsetY = 0;
  }

  private updateCursor(): void {
    if (!this.cell || this.session.tool === 'camera') {
      this.cursor = null;
      return;
    }
    this.cursor = {
      x: this.cell.x,
      y: this.cell.y,
      radius: this.session.brush.radius,
      mode: this.session.tool === 'lower' ? 'lower' : 'raise',
    };
  }

  /** 毎フレーム呼ぶ。押している間だけ地形を変える（フレームレートに依らない量） */
  update(dtReal: number): void {
    if (this.armed && performance.now() - this.armedAt > GESTURE_DELAY) {
      this.armed = false;
      this.editing = true;
      this.dwell = 0;
    }
    if (!this.editing) return;
    this.dwell += dtReal;
    this.applyEdit(dtReal);
  }

  private applyEdit(dtReal: number): void {
    const cell = this.cell;
    if (!cell) return;
    const session = this.session;
    const brush = session.brush;
    const dir = session.tool === 'lower' ? -1 : 1;
    const gain = 1 + Math.min(MAX_DWELL_GAIN, this.dwell * 1.4);
    let amount = dir * BASE_EDIT_RATE * brush.strength * gain * dtReal;

    // 使用できる砂に上限があるときは、超えないように量を絞る
    const remaining = session.sandRemaining;
    if (remaining !== null) {
      if (remaining <= 1e-6) {
        this.editing = false;
        this.onOutOfSand?.();
        return;
      }
      const area = session.sim.cellArea;
      // ブラシの重み積分のおおよその値
      const perUnit = 0.45 * Math.PI * brush.radius * brush.radius * area;
      const predicted = Math.abs(amount) * perUnit;
      if (predicted > remaining) amount *= remaining / predicted;
    }

    session.sim.modifyTerrain(cell.x, cell.y, brush.radius, amount);
    this.updateCursor();
  }
}

function preventDefault(e: Event): void {
  e.preventDefault();
}

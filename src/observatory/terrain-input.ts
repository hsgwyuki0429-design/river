import type { Landscape } from './renderer.ts';
import { insideTerrain, TerrainStroke, type TerrainTool } from './terrain.ts';
import type { Point } from './model.ts';

export interface TerrainInputOptions {
  canEdit(): boolean;
  begin(): void;
  paint(points: Point[], radius: number, tool: TerrainTool): void;
  finish(cancelled: boolean): void;
  changed(): void;
}

/** Pointer capture handles mouse/pen/touch; one gesture is one undo transaction. */
export class TerrainInput {
  tool: TerrainTool | null = null;
  radius = 140;
  private pointer: number | null = null;
  private stroke: TerrainStroke | null = null;
  constructor(private landscape: Landscape, private options: TerrainInputOptions) {
    const canvas = landscape.canvas;
    canvas.addEventListener('pointerdown', e => {
      if (!this.tool || !options.canEdit() || e.button !== 0 || !e.isPrimary || this.pointer !== null) return;
      const point = landscape.screenToWorld(e.clientX, e.clientY);
      if (!insideTerrain(point)) return;
      e.preventDefault(); canvas.focus({ preventScroll: true });
      this.pointer = e.pointerId; canvas.setPointerCapture(e.pointerId);
      this.stroke = new TerrainStroke(point, this.radius * 0.35);
      options.begin(); this.options.paint([point], this.radius, this.tool); this.show(point);
    });
    canvas.addEventListener('pointermove', e => {
      const point = landscape.screenToWorld(e.clientX, e.clientY);
      if (this.pointer === e.pointerId && this.stroke && this.tool) {
        const centers = this.stroke.move(point);
        if (centers.length) options.paint(centers, this.radius, this.tool);
      }
      if (this.pointer === null || this.pointer === e.pointerId) this.show(point);
    });
    canvas.addEventListener('pointerup', e => { if (this.pointer === e.pointerId) this.finish(false); });
    canvas.addEventListener('pointercancel', e => { if (this.pointer === e.pointerId) this.finish(true); });
    canvas.addEventListener('lostpointercapture', e => { if (this.pointer === e.pointerId) this.finish(false); });
    canvas.addEventListener('pointerleave', () => { if (this.pointer === null) { landscape.cursor = null; options.changed(); } });
    canvas.addEventListener('keydown', e => {
      if (!this.tool || !options.canEdit()) return;
      const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      if (directions[e.key]) {
        e.preventDefault();
        const point = landscape.cursor?.point ?? landscape.screenToWorld(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2);
        // Convert screen-axis key movement through the same rotated map transform.
        const origin = landscape.screenToWorld(0, 0), delta = landscape.screenToWorld(directions[e.key].x * 12, directions[e.key].y * 12);
        const next = { x: point.x + delta.x - origin.x, y: point.y + delta.y - origin.y };
        if (insideTerrain(next)) this.show(next);
      } else if (e.key === 'Enter' && landscape.cursor) {
        e.preventDefault(); options.begin(); options.paint([landscape.cursor.point], this.radius, this.tool); options.finish(false);
      } else if (e.key === 'Escape') { e.preventDefault(); this.finish(true); }
    });
  }
  setTool(tool: TerrainTool | null): void {
    this.finish(false); this.tool = tool;
    this.landscape.canvas.classList.toggle('editing', tool !== null);
    this.landscape.canvas.setAttribute('role', tool ? 'application' : 'img');
    this.landscape.canvas.setAttribute('aria-label', tool ? '地形編集。矢印キーで位置を移動し、Enterで地形を変更します。' : '川と編集した地形の俯瞰図');
    if (!tool) this.landscape.cursor = null;
    else {
      const rect = this.landscape.canvas.getBoundingClientRect();
      this.show(this.landscape.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }
    this.options.changed();
  }
  cancel(): void { this.finish(true); }
  private show(point: Point): void {
    this.landscape.cursor = this.tool && this.options.canEdit() && insideTerrain(point) ? { point, radius: this.radius, tool: this.tool } : null;
    this.options.changed();
  }
  private finish(cancelled: boolean): void {
    if (this.pointer === null) return;
    const pointer = this.pointer; this.pointer = null; this.stroke = null;
    if (this.landscape.canvas.hasPointerCapture(pointer)) this.landscape.canvas.releasePointerCapture(pointer);
    this.options.finish(cancelled);
  }
}

import { channelWidth, curvature, distance, type Point, type RiverState } from './model.ts';

export interface Layers { trails: boolean; flow: boolean; terrain: boolean }
export class Landscape {
  private ctx: CanvasRenderingContext2D;
  private texture = document.createElement('canvas');
  private scale = 1;
  private width = 1;
  private height = 1;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.texture.width = 700; this.texture.height = 700;
    const ctx = this.texture.getContext('2d')!;
    let seed = 723;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 35000; i++) {
      ctx.fillStyle = `rgba(70,85,53,${random() * 0.11})`;
      ctx.fillRect(random() * 700, random() * 700, 0.5 + random(), 0.5 + random());
    }
  }
  resize(): void {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    this.width = rect.width; this.height = rect.height;
    if (this.canvas.width !== Math.round(rect.width * dpr) || this.canvas.height !== Math.round(rect.height * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr); this.canvas.height = Math.round(rect.height * dpr);
    }
  }
  draw(state: RiverState, history: RiverState[], layers: Layers, motion: number): void {
    this.resize();
    const ctx = this.ctx, w = this.width, h = this.height;
    if (!w || !h) return;
    const dpr = this.canvas.width / w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = layers.terrain ? '#e2e5d2' : '#f0f0e8'; ctx.fillRect(0, 0, w, h);
    if (layers.terrain) {
      const wash = ctx.createLinearGradient(0, 0, w, h);
      wash.addColorStop(0, '#d4ddc5'); wash.addColorStop(0.45, '#e8e7d4'); wash.addColorStop(1, '#ccd9bd');
      ctx.fillStyle = wash; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = ctx.createPattern(this.texture, 'repeat')!; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#92a38320'; ctx.lineWidth = 0.8;
      for (let i = -5; i < 30; i++) {
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 12) {
          const y = i * 37 + 28 * Math.sin(x / 157 + i * 0.19) + 12 * Math.cos(x / 71 + i * 0.09);
          if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    const all = [...state.points, ...state.oxbows.flatMap(o => o.points)];
    let minX = -100, maxX = 1900, minY = -330, maxY = 330;
    for (const p of all) { minX = Math.min(minX, p.x - 100); maxX = Math.max(maxX, p.x + 100); minY = Math.min(minY, p.y - 100); maxY = Math.max(maxY, p.y + 100); }
    const portrait = w < 580 && h > w;
    this.canvas.dataset.portrait = String(portrait);
    const spanX = maxX - minX, spanY = maxY - minY;
    this.scale = Math.min((w - 54) / (portrait ? spanY : spanX), (h - 100) / (portrait ? spanX : spanY));
    ctx.save(); ctx.translate(w / 2, h / 2 + 4); ctx.scale(this.scale, this.scale);
    if (portrait) ctx.rotate(Math.PI / 2);
    ctx.translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    const width = channelWidth(state.flow);
    if (layers.trails) {
      const before = history.filter(s => s.year < state.year);
      const stride = Math.max(1, Math.floor(before.length / 26));
      for (let i = 0; i < before.length; i += stride) this.stroke(before[i].points, '#85917115', width * 1.9);
      for (let i = 0; i < before.length; i += stride) this.stroke(before[i].points, '#87957750', 1 / this.scale);
    }
    for (const oxbow of state.oxbows) {
      const age = state.year - oxbow.born;
      this.stroke(oxbow.points, '#b7c8a5', oxbow.width * 1.55);
      // Conceptual abandonment/vegetation; not a computed water-level budget.
      this.stroke(oxbow.points.slice(2, -2), age < 120 ? '#80b4a6' : '#a0baa3', oxbow.width * (age < 120 ? 0.75 : 0.5));
    }
    this.stroke(state.points, '#b3b997', width * 1.85);
    this.stroke(state.points, '#e5d6ae', width * 1.7);
    this.stroke(state.points, '#418f88', width * 1.05);
    this.stroke(state.points, '#65aba0', width * 0.8);
    this.stroke(state.points, '#83bfb0', width * 0.43);
    const bends = curvature(state.points);
    for (let i = 3; i < state.points.length - 3; i++) {
      const k = bends[i];
      if (Math.abs(k) * width < 0.11) continue;
      const a = state.points[i - 1], b = state.points[i], c = state.points[i + 1];
      const norm = distance(a, c), side = Math.sign(k);
      const ox = -(c.y - a.y) / norm * width * 0.43 * side, oy = (c.x - a.x) / norm * width * 0.43 * side;
      this.stroke([{ x: a.x + ox, y: a.y + oy }, { x: b.x + ox, y: b.y + oy }, { x: c.x + ox, y: c.y + oy }], '#e4d4a6', width * 0.26);
    }
    if (layers.flow) {
      ctx.strokeStyle = '#e2f2dcb0'; ctx.lineWidth = 1.2 / this.scale;
      const offset = Math.floor(motion * 8) % 9;
      for (let i = 2 + offset; i < state.points.length - 2; i += 9) {
        const a = state.points[i], b = state.points[i + 1], angle = Math.atan2(b.y - a.y, b.x - a.x);
        const size = Math.min(width * 0.22, 3 / this.scale);
        ctx.beginPath(); ctx.moveTo(a.x - Math.cos(angle - 0.55) * size, a.y - Math.sin(angle - 0.55) * size);
        ctx.lineTo(a.x, a.y); ctx.lineTo(a.x - Math.cos(angle + 0.55) * size, a.y - Math.sin(angle + 0.55) * size); ctx.stroke();
      }
    }
    for (const [p, label] of [[state.points[0], '上流'], [state.points.at(-1)!, '下流']] as const) {
      ctx.save(); ctx.translate(p.x, p.y);
      if (portrait) ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#49604d'; ctx.font = `${9 / this.scale}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText(label, 0, -17 / this.scale); ctx.restore();
    }
    ctx.restore();
    ctx.fillStyle = '#415a4c'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    const scaleMetres = this.scale * 200 > w * 0.28 ? 100 : 200;
    const sx = 24, sy = h - 25, bar = scaleMetres * this.scale;
    ctx.strokeStyle = '#506151'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy); ctx.lineTo(sx + bar, sy); ctx.lineTo(sx + bar, sy - 5); ctx.stroke();
    ctx.fillText(`${scaleMetres} m`, sx, sy - 10);
    ctx.textAlign = 'right'; ctx.fillText(`RIVER / ${Math.floor(state.year)} 年 · 概念モデル`, w - 22, h - 24);
  }
  private stroke(points: readonly Point[], color: string, width: number): void {
    if (points.length < 2) return;
    const ctx = this.ctx; ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1]; ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const end = points[points.length - 1]; ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }
}

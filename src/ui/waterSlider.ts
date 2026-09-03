/**
 * 画面右端の縦型スライダー。
 *
 * これが変えるのは盤面全体の水位ではなく、
 * 「水源から単位時間あたりに流れ込む量」。値は即座にシミュレーションへ反映する。
 *
 *   最下部 : 流入停止
 *   低     : 細い流れ
 *   中     : 通常の河川
 *   高     : 増水
 *   最大   : 洪水級
 */

export class WaterSlider {
  private root: HTMLElement;
  private track: HTMLElement;
  private fill: HTMLElement;
  private minBar: HTMLElement;
  private thumb: HTMLElement;
  private value = 0;
  private minValue = 0;
  private dragging = false;

  onChange: (value: number) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.track = root.querySelector('.ws-track') as HTMLElement;
    this.fill = root.querySelector('.ws-fill') as HTMLElement;
    this.minBar = root.querySelector('.ws-min') as HTMLElement;
    this.thumb = root.querySelector('.ws-thumb') as HTMLElement;

    root.addEventListener('pointerdown', this.onDown, { passive: false });
    root.addEventListener('pointermove', this.onMove, { passive: false });
    root.addEventListener('pointerup', this.onUp, { passive: false });
    root.addEventListener('pointercancel', this.onUp, { passive: false });
    root.addEventListener('keydown', this.onKey);
    root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  private valueFromEvent(e: PointerEvent): number {
    const rect = this.track.getBoundingClientRect();
    const t = 1 - (e.clientY - rect.top) / Math.max(1, rect.height);
    return Math.max(0, Math.min(1, t));
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.dragging = true;
    capturePointer(this.root, e.pointerId);
    this.set(this.valueFromEvent(e), true);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    e.preventDefault();
    this.set(this.valueFromEvent(e), true);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    releasePointer(this.root, e.pointerId);
  };

  private onKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 0.2 : 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.set(this.value + step, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.set(this.value - step, true);
    else if (e.key === 'Home') this.set(1, true);
    else if (e.key === 'End') this.set(0, true);
    else return;
    e.preventDefault();
  };

  /** スライダーの下限（ステージが強制する最低流量） */
  setMin(min: number): void {
    this.minValue = Math.max(0, Math.min(1, min));
    this.minBar.style.height = `${this.minValue * 100}%`;
    if (this.value < this.minValue) this.set(this.minValue, true);
    else this.render();
  }

  set(value: number, notify: boolean): void {
    const v = Math.max(this.minValue, Math.min(1, value));
    const changed = v !== this.value;
    this.value = v;
    this.render();
    if (notify && changed) this.onChange(v);
  }

  get(): number {
    return this.value;
  }

  private render(): void {
    const pct = this.value * 100;
    this.fill.style.height = `${pct}%`;
    this.thumb.style.bottom = `${pct}%`;
    this.root.setAttribute('aria-valuenow', String(Math.round(pct)));
    this.root.setAttribute('aria-valuetext', describeInflow(this.value));
  }
}

export function describeInflow(v: number): string {
  if (v <= 0.001) return '流入停止';
  if (v < 0.3) return '細い流れ';
  if (v < 0.55) return '通常の河川';
  if (v < 0.8) return '増水';
  return '洪水級';
}

/** ポインタ捕捉。既に解放済みなどで失敗しても致命的ではないので握りつぶす */
function capturePointer(el: Element, id: number): void {
  try {
    el.setPointerCapture?.(id);
  } catch {
    /* ignore */
  }
}

function releasePointer(el: Element, id: number): void {
  try {
    el.releasePointerCapture?.(id);
  } catch {
    /* ignore */
  }
}

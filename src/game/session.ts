/**
 * ゲーム全体の進行状態。
 *
 * 描画・入力・UI から参照される「唯一の状態」。
 * シミュレーションの時間進行（固定時間刻み）と、端末性能に応じた負荷調整もここで行う。
 */

import { Simulation } from '../sim/simulation.ts';
import type { StageDef } from './stage.ts';
import { STAGES } from './stages.ts';
import { createWorld, resetWorld, SANDBOX_STAGE, type World } from './world.ts';
import { loadFromStorage, saveToStorage } from './saveLoad.ts';
import type { DebugLayer } from '../render/palette.ts';
import type { ViewMode } from '../render/renderer.ts';

export type GameMode = 'title' | 'stage' | 'sandbox';
export type ToolMode = 'raise' | 'lower' | 'camera';

/** ブラシの大きさ 3段階 */
export const BRUSH_SIZES = [
  { label: '細い', radius: 2.0, strength: 0.85 },
  { label: '普通', radius: 3.5, strength: 1.0 },
  { label: '広い', radius: 5.5, strength: 1.15 },
];

/** シミュレーション速度 */
export const SPEEDS = [
  { label: '一時停止', value: 0 },
  { label: '0.5倍', value: 0.5 },
  { label: '1倍', value: 1 },
  { label: '2倍', value: 2 },
  { label: '4倍', value: 4 },
];

/** 実時間1秒あたりに進めるシミュレーション時間の基準倍率 */
export const BASE_TIME_SCALE = 2.5;

/** 端末性能に応じた格子解像度 */
export const QUALITY_PRESETS = [
  { label: '低', width: 64, height: 96, maxSubsteps: 2 },
  { label: '中', width: 80, height: 120, maxSubsteps: 3 },
  { label: '高', width: 96, height: 144, maxSubsteps: 4 },
];

export const CELL_SIZE = 0.5;

export interface PerfStats {
  fps: number;
  simMs: number;
  renderMs: number;
  stepsPerFrame: number;
  quality: string;
  renderScale: number;
}

/** 端末から初期品質を推定する */
export function detectQuality(): number {
  if (typeof navigator === 'undefined') return 2;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores <= 3 || mem <= 2) return 0;
  if (cores <= 5 || mem <= 4) return 1;
  return 2;
}

export class Session {
  mode: GameMode = 'title';
  stage: StageDef | null = null;
  world: World;
  tool: ToolMode = 'raise';
  brushIndex = 1;
  speedIndex = 2;
  qualityIndex: number;
  /** 水量スライダーの値 0..1 */
  inflow = 0;
  /** 地形変化倍率（開発用の調整値） */
  morphScale = 1;
  /** 描画品質 (0.6..1) */
  renderScale = 1;
  /** 真上ビューの描画拡大率（1セルを何ピクセルで描くか） */
  superSample = 2;

  // --- 表示設定 ---
  view: ViewMode = 'top';
  debugLayer: DebugLayer = 'none';
  showVelocity = false;
  showDebug = false;

  readonly perf: PerfStats = {
    fps: 60,
    simMs: 0,
    renderMs: 0,
    stepsPerFrame: 0,
    quality: '高',
    renderScale: 1,
  };

  private accumulator = 0;
  private validateTimer = 0;
  private warnedBudget = false;
  private frameTimes: number[] = [];
  private lowFrames = 0;
  private highFrames = 0;

  constructor(qualityIndex = detectQuality()) {
    this.qualityIndex = Math.max(0, Math.min(QUALITY_PRESETS.length - 1, qualityIndex));
    this.world = this.buildWorld(SANDBOX_STAGE);
    this.perf.quality = QUALITY_PRESETS[this.qualityIndex].label;
  }

  private buildWorld(stage: StageDef): World {
    const q = QUALITY_PRESETS[this.qualityIndex];
    return createWorld(stage, {
      width: q.width,
      height: q.height,
      cellSize: CELL_SIZE,
      params: { maxSubsteps: q.maxSubsteps },
    });
  }

  get sim(): Simulation {
    return this.world.sim;
  }

  get activeStage(): StageDef {
    return this.stage ?? SANDBOX_STAGE;
  }

  get speed(): number {
    return SPEEDS[this.speedIndex].value;
  }

  get paused(): boolean {
    return this.speed === 0;
  }

  get brush() {
    return BRUSH_SIZES[this.brushIndex];
  }

  /** 使用した砂の量 [m^3] */
  get sandUsed(): number {
    return this.sim.budget.sandAdded + this.sim.budget.sandRemoved;
  }

  /** 残りの砂 [m^3]。無制限なら null */
  get sandRemaining(): number | null {
    const budget = this.activeStage.sandBudget;
    return budget === null ? null : Math.max(0, budget - this.sandUsed);
  }

  startStage(stageId: string): void {
    const stage = STAGES.find((s) => s.id === stageId);
    if (!stage) return;
    this.stage = stage;
    this.mode = 'stage';
    this.world = this.buildWorld(stage);
    this.inflow = stage.initialInflow;
    this.sim.inflowScale = this.inflow;
    this.speedIndex = 2;
    this.accumulator = 0;
    this.applyMorphScale();
  }

  startSandbox(): void {
    this.stage = null;
    this.mode = 'sandbox';
    this.world = this.buildWorld(SANDBOX_STAGE);
    this.inflow = SANDBOX_STAGE.initialInflow;
    this.sim.inflowScale = this.inflow;
    this.speedIndex = 2;
    this.accumulator = 0;
    this.applyMorphScale();
  }

  toTitle(): void {
    this.mode = 'title';
  }

  reset(): void {
    resetWorld(this.world, this.activeStage);
    this.inflow = this.activeStage.initialInflow;
    this.sim.inflowScale = this.inflow;
    this.accumulator = 0;
  }

  save(): boolean {
    return saveToStorage(this.sim);
  }

  load(): boolean {
    const ok = loadFromStorage(this.sim);
    if (ok) this.inflow = this.sim.inflowScale;
    return ok;
  }

  setInflow(value: number): void {
    const min = this.activeStage.minInflow;
    this.inflow = Math.max(min, Math.min(1, value));
    this.sim.inflowScale = this.inflow;
  }

  applyMorphScale(): void {
    this.sim.params.morphologicalTimeScale = 8 * this.morphScale;
  }

  /**
   * 実時間 dtReal [s] だけゲームを進める。
   * シミュレーションは固定時間刻みで積分するので、フレームレートが揺れても結果は変わらない。
   */
  update(dtReal: number): void {
    const sim = this.sim;
    const fixed = sim.params.fixedDt;
    const speed = this.speed;
    if (speed <= 0) {
      this.accumulator = 0;
      this.perf.stepsPerFrame = 0;
      return;
    }

    this.accumulator += Math.min(0.1, dtReal) * speed * BASE_TIME_SCALE;
    const maxSteps = this.maxStepsPerFrame();
    let steps = 0;
    const t0 = now();
    while (this.accumulator >= fixed && steps < maxSteps) {
      sim.step(fixed);
      this.accumulator -= fixed;
      steps++;
    }
    // 追いつけない分は捨てる（無限に溜め込まない）
    if (this.accumulator > fixed * maxSteps) this.accumulator = 0;
    this.perf.simMs = now() - t0;
    this.perf.stepsPerFrame = steps;

    this.watchNumerics(dtReal);

    const tracker = this.world.tracker;
    if (tracker && this.mode === 'stage') {
      const dtSim = steps * fixed;
      tracker.accumulateFlood(sim, dtSim);
      tracker.update(sim, dtSim);
    }
  }

  /**
   * 数値破綻と収支のずれを定期的に監視する。
   * 破綻は検出して修復し、収支が許容範囲を超えたら開発時に気づけるよう警告する。
   */
  private watchNumerics(dtReal: number): void {
    this.validateTimer += dtReal;
    if (this.validateTimer < 3) return;
    this.validateTimer = 0;

    const { faults } = this.sim.validate();
    if (faults > 0) {
      console.warn(`[river] 数値破綻を ${faults} 件検出して修復しました`);
    }
    if (!this.sim.budgetWithinTolerance(1e-4)) {
      if (!this.warnedBudget) {
        this.warnedBudget = true;
        console.warn(
          '[river] 収支の誤差が許容範囲を超えました',
          '水:', this.sim.stats.waterError,
          '土砂:', this.sim.stats.sedimentError,
        );
      }
    } else {
      this.warnedBudget = false;
    }
  }

  /** フレーム時間から負荷を判断し、サブステップ数と描画品質を段階的に下げる */
  adaptPerformance(frameMs: number): void {
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.perf.fps = avg > 0 ? 1000 / avg : 60;

    if (avg > 33) {
      this.lowFrames++;
      this.highFrames = 0;
    } else if (avg < 20) {
      this.highFrames++;
      this.lowFrames = 0;
    }

    // 重いときは 描画拡大率 → サブステップ数 → 描画解像度 の順に段階的に下げる
    const q = QUALITY_PRESETS[this.qualityIndex];
    if (this.lowFrames > 30) {
      this.lowFrames = 0;
      if (this.superSample > 1) {
        this.superSample = 1;
      } else if (this.sim.params.maxSubsteps > 1) {
        this.sim.params.maxSubsteps--;
      } else if (this.renderScale > 0.6) {
        this.renderScale = Math.max(0.6, this.renderScale - 0.15);
      }
    } else if (this.highFrames > 120) {
      this.highFrames = 0;
      if (this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.15);
      else if (this.sim.params.maxSubsteps < q.maxSubsteps) this.sim.params.maxSubsteps++;
      else if (this.superSample < 2) this.superSample = 2;
    }
    this.perf.renderScale = this.renderScale;
    this.perf.quality = q.label;
  }

  private maxStepsPerFrame(): number {
    // 4倍速でも追いつけるよう余裕を持たせつつ、上限を設けて暴走を防ぐ
    return this.perf.fps < 40 ? 6 : 10;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

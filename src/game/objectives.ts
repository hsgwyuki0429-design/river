/**
 * お題（ステージ）の判定。
 *
 * StageDef に書かれた条件データだけを見て評価する。
 * ここに個別ステージ固有の分岐は書かない。
 */

import type { Simulation } from '../sim/simulation.ts';
import type {
  Condition,
  ConditionState,
  StageDef,
  StageMetrics,
  StageResult,
  Zone,
} from './stage.ts';

/** 区域ごとの前計算済みセル一覧 */
export interface ZoneMask {
  zone: Zone;
  cells: Int32Array;
  /** 判定開始時点の地盤高（堆積量の測定に使う） */
  baseBed: Float32Array;
}

export function buildZoneMasks(zones: Zone[], width: number, height: number): Map<string, ZoneMask> {
  const map = new Map<string, ZoneMask>();
  for (const zone of zones) {
    const cells: number[] = [];
    const x0 = Math.max(0, Math.floor(zone.rect.x * width));
    const x1 = Math.min(width - 1, Math.ceil((zone.rect.x + zone.rect.w) * width) - 1);
    const y0 = Math.max(0, Math.floor(zone.rect.y * height));
    const y1 = Math.min(height - 1, Math.ceil((zone.rect.y + zone.rect.h) * height) - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) cells.push(y * width + x);
    }
    map.set(zone.id, {
      zone,
      cells: Int32Array.from(cells),
      baseBed: new Float32Array(cells.length),
    });
  }
  return map;
}

/** 地形確定後に呼び、堆積量の基準となる地盤高を記録する */
export function snapshotZoneBase(masks: Map<string, ZoneMask>, bed: Float32Array): void {
  for (const mask of masks.values()) {
    for (let k = 0; k < mask.cells.length; k++) mask.baseBed[k] = bed[mask.cells[k]];
  }
}

/**
 * 条件の継続時間などを保持しながらステージを判定する。
 * update() は毎フレームではなく数Hzで呼べば十分。
 */
export class ObjectiveTracker {
  readonly stage: StageDef;
  readonly masks: Map<string, ZoneMask>;
  private sustained = new Map<string, number>();
  private floodVolume = 0;
  private connectivity: Uint8Array;

  readonly successStates: ConditionState[] = [];
  readonly failureStates: ConditionState[] = [];
  readonly metrics: StageMetrics = {
    elapsed: 0,
    achievement: 0,
    floodVolume: 0,
    sandUsed: 0,
    waterLost: 0,
    depositVolume: 0,
    drainedVolume: 0,
    sedimentLost: 0,
  };
  result: StageResult = {
    cleared: false,
    failed: false,
    failReason: '',
    stars: 0,
    metrics: this.metrics,
  };

  constructor(stage: StageDef, sim: Simulation) {
    this.stage = stage;
    this.masks = buildZoneMasks(stage.zones, sim.grid.width, sim.grid.height);
    snapshotZoneBase(this.masks, sim.grid.bedHeight);
    this.connectivity = new Uint8Array(sim.grid.size);
  }

  reset(sim: Simulation): void {
    this.sustained.clear();
    this.floodVolume = 0;
    snapshotZoneBase(this.masks, sim.grid.bedHeight);
    this.result = {
      cleared: false,
      failed: false,
      failReason: '',
      stars: 0,
      metrics: this.metrics,
    };
  }

  /** 浸水禁止区域への流入量は毎フレーム積算する（瞬間値では取りこぼすため） */
  accumulateFlood(sim: Simulation, dt: number): void {
    const area = sim.cellArea;
    for (const mask of this.masks.values()) {
      if (mask.zone.kind !== 'protected') continue;
      let v = 0;
      for (let k = 0; k < mask.cells.length; k++) {
        const d = sim.grid.waterDepth[mask.cells[k]];
        if (d > 0.01) v += d;
      }
      // 「その瞬間に区域内にある水量」の時間平均ではなく、
      // ピーク浸水量を評価に使う（一度でも浸かったら記録される）
      this.floodVolume = Math.max(this.floodVolume, v * area);
    }
    this.metrics.elapsed = sim.elapsed;
    void dt;
  }

  update(sim: Simulation, dt: number): StageResult {
    const m = this.metrics;
    m.elapsed = sim.elapsed;
    m.floodVolume = this.floodVolume;
    m.sandUsed = sim.budget.sandAdded + sim.budget.sandRemoved;
    m.waterLost = sim.budget.waterOut;
    m.drainedVolume = sim.budget.waterOut;
    m.depositVolume = this.depositVolume(sim);
    m.sedimentLost = sim.budget.sedimentOut;

    this.successStates.length = 0;
    let progressSum = 0;
    let allSatisfied = this.stage.success.length > 0;
    for (const c of this.stage.success) {
      const st = this.evaluate(c, sim, dt, true);
      this.successStates.push(st);
      progressSum += st.progress;
      if (!st.satisfied) allSatisfied = false;
    }
    m.achievement = this.stage.success.length
      ? progressSum / this.stage.success.length
      : 0;

    this.failureStates.length = 0;
    let failed = false;
    let failReason = '';
    for (const c of this.stage.failure) {
      const st = this.evaluate(c, sim, dt, false);
      this.failureStates.push(st);
      if (st.satisfied && !failed) {
        failed = true;
        failReason = st.label;
      }
    }

    if (!this.result.cleared && !this.result.failed) {
      if (allSatisfied) {
        this.result.cleared = true;
        this.result.stars = this.computeStars();
      } else if (failed) {
        this.result.failed = true;
        this.result.failReason = failReason;
      }
    }
    return this.result;
  }

  /** 指定区域（deposit）への堆積量 [m^3] */
  private depositVolume(sim: Simulation): number {
    let total = 0;
    for (const mask of this.masks.values()) {
      if (mask.zone.kind !== 'deposit') continue;
      let v = 0;
      for (let k = 0; k < mask.cells.length; k++) {
        const diff = sim.grid.bedHeight[mask.cells[k]] - mask.baseBed[k];
        if (diff > 0) v += diff;
      }
      total += v * sim.cellArea;
    }
    return total;
  }

  private evaluate(
    c: Condition,
    sim: Simulation,
    dt: number,
    isSuccess: boolean,
  ): ConditionState {
    switch (c.type) {
      case 'waterInZone': {
        const mask = this.masks.get(c.zone);
        if (!mask) return { label: c.label, progress: 0, satisfied: false, detail: '-' };
        let hit = 0;
        for (let k = 0; k < mask.cells.length; k++) {
          if (sim.grid.waterDepth[mask.cells[k]] >= c.minDepth) hit++;
        }
        const coverage = mask.cells.length ? hit / mask.cells.length : 0;
        const met = coverage >= c.minCoverage;
        const held = this.hold(c.label, met, dt, c.sustain);
        return {
          label: c.label,
          progress: Math.min(1, coverage / Math.max(1e-6, c.minCoverage)) * (met ? 1 : 0.9),
          satisfied: held,
          detail: `${Math.round(coverage * 100)}% / ${Math.round(c.minCoverage * 100)}%`,
        };
      }

      case 'connectZones': {
        const connected = this.checkConnection(sim, c.from, c.to, c.minDepth);
        const held = this.hold(c.label, connected, dt, c.sustain);
        return {
          label: c.label,
          progress: connected ? 1 : 0,
          satisfied: held,
          detail: connected ? 'つながっている' : '未接続',
        };
      }

      case 'sedimentInZone': {
        const v = this.metrics.depositVolume;
        return {
          label: c.label,
          progress: Math.min(1, v / c.volume),
          satisfied: v >= c.volume,
          detail: `${v.toFixed(1)} / ${c.volume.toFixed(1)} m³`,
        };
      }

      case 'drainedWater': {
        const v = sim.budget.waterOut;
        return {
          label: c.label,
          progress: Math.min(1, v / c.volume),
          satisfied: v >= c.volume,
          detail: `${v.toFixed(0)} / ${c.volume.toFixed(0)} m³`,
        };
      }

      case 'sedimentLostLimit': {
        const v = sim.budget.sedimentOut;
        const over = v > c.volume;
        return {
          label: c.label,
          progress: Math.min(1, v / c.volume),
          satisfied: isSuccess ? !over : over,
          detail: `${v.toFixed(1)} / ${c.volume.toFixed(1)} m³`,
        };
      }

      case 'floodLimit': {
        const v = this.floodVolume;
        const over = v > c.maxVolume;
        return {
          label: c.label,
          progress: Math.min(1, v / c.maxVolume),
          satisfied: isSuccess ? !over : over,
          detail: `${v.toFixed(2)} / ${c.maxVolume.toFixed(2)} m³`,
        };
      }

      case 'sandLimit': {
        const v = this.metrics.sandUsed;
        const over = v > c.volume;
        return {
          label: c.label,
          progress: Math.min(1, v / c.volume),
          satisfied: isSuccess ? !over : over,
          detail: `${v.toFixed(1)} / ${c.volume.toFixed(1)} m³`,
        };
      }

      case 'timeLimit': {
        const over = sim.elapsed > c.seconds;
        return {
          label: c.label,
          progress: Math.min(1, sim.elapsed / c.seconds),
          satisfied: isSuccess ? !over : over,
          detail: `残り ${Math.max(0, c.seconds - sim.elapsed).toFixed(0)} 秒`,
        };
      }
    }
  }

  /** 条件が sustain 秒だけ継続したか */
  private hold(key: string, met: boolean, dt: number, sustain: number): boolean {
    const prev = this.sustained.get(key) ?? 0;
    const next = met ? prev + dt : 0;
    this.sustained.set(key, next);
    return next >= sustain;
  }

  /** 濡れたセルをたどって2つの区域がつながっているか調べる */
  private checkConnection(sim: Simulation, fromId: string, toId: string, minDepth: number): boolean {
    const a = this.masks.get(fromId);
    const b = this.masks.get(toId);
    if (!a || !b) return false;
    const g = sim.grid;
    const visited = this.connectivity;
    visited.fill(0);
    const target = new Set<number>();
    for (let k = 0; k < b.cells.length; k++) target.add(b.cells[k]);

    const stack: number[] = [];
    for (let k = 0; k < a.cells.length; k++) {
      const i = a.cells[k];
      if (g.waterDepth[i] >= minDepth && visited[i] === 0) {
        visited[i] = 1;
        stack.push(i);
      }
    }
    const { width, height } = g;
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (target.has(i)) return true;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0) this.pushIf(stack, visited, g.waterDepth, i - 1, minDepth);
      if (x < width - 1) this.pushIf(stack, visited, g.waterDepth, i + 1, minDepth);
      if (y > 0) this.pushIf(stack, visited, g.waterDepth, i - width, minDepth);
      if (y < height - 1) this.pushIf(stack, visited, g.waterDepth, i + width, minDepth);
    }
    return false;
  }

  private pushIf(
    stack: number[],
    visited: Uint8Array,
    depth: Float32Array,
    i: number,
    minDepth: number,
  ): void {
    if (visited[i] === 0 && depth[i] >= minDepth) {
      visited[i] = 1;
      stack.push(i);
    }
  }

  /**
   * 評価項目から星を算出する。
   * 目標達成に加えて「時間」「砂の使用量」「浸水量」を見る。
   */
  private computeStars(): number {
    const s = this.stage;
    const m = this.metrics;
    let stars = 1;
    if (m.elapsed <= s.targetTime) stars++;
    const budget = s.sandBudget;
    const economical = budget === null ? m.sandUsed < 30 : m.sandUsed <= budget * 0.7;
    const clean =
      s.zones.every((z) => z.kind !== 'protected') || m.floodVolume < 0.5;
    if (economical && clean) stars++;
    return Math.min(3, stars);
  }
}

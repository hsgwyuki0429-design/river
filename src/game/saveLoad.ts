/**
 * 自由モードの地形の保存・読み込み（localStorage）。
 *
 * Float32Array をそのまま base64 にして保存する。
 * 解像度が違う保存データは線形補間で読み込む。
 */

import type { Simulation } from '../sim/simulation.ts';
import type { CirculationState, SimParams } from '../sim/types.ts';

export const SAVE_KEY = 'river.sandbox.save.v1';

export interface SaveData {
  version: 1 | 2 | 3;
  width: number;
  height: number;
  cellSize: number;
  savedAt: number;
  inflow: number;
  source: { x: number; y: number; radius: number; maxRate: number } | null;
  bed: string;
  water: string;
  sediment: string;
  bedload?: string;
  bedrock?: string;
  erodibility?: string;
  secondaryFlow?: string;
  lowVelocityAge?: string;
  circulation?: CirculationState;
  circulationWaterByColumn?: number[];
  circulationSuspendedSedimentByColumn?: number[];
  circulationBedloadSedimentByColumn?: number[];
  params?: Partial<SimParams>;
  presetId?: string;
  seed?: number;
}

function encodeFloats(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function decodeFloats(text: string): Float32Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}

/** 解像度が違う場合に備えた双線形サンプリング */
function resample(
  src: Float32Array,
  sw: number,
  sh: number,
  dst: Float32Array,
  dw: number,
  dh: number,
): void {
  if (sw === dw && sh === dh) {
    dst.set(src.subarray(0, Math.min(src.length, dst.length)));
    return;
  }
  for (let y = 0; y < dh; y++) {
    const v = ((y + 0.5) / dh) * sh - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(v)));
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, v - y0));
    for (let x = 0; x < dw; x++) {
      const u = ((x + 0.5) / dw) * sw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(u)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, u - x0));
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      dst[y * dw + x] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
  }
}

/** 幅の異なる保存データをX列状態へ線形補間し、指定した総量へ正規化する。 */
function restoreColumns(src: number[], dst: Float64Array, total: number): void {
  let sum = 0;
  for (let x = 0; x < dst.length; x++) {
    const u = ((x + 0.5) / dst.length) * src.length - 0.5;
    const x0 = Math.max(0, Math.min(src.length - 1, Math.floor(u)));
    const x1 = Math.min(src.length - 1, x0 + 1);
    const f = Math.max(0, Math.min(1, u - x0));
    dst[x] = Math.max(0, src[x0] * (1 - f) + src[x1] * f);
    sum += dst[x];
  }
  if (sum > 0) {
    const scale = total / sum;
    for (let x = 0; x < dst.length; x++) dst[x] *= scale;
  } else {
    dst.fill(total / dst.length);
  }
}

export function serialize(sim: Simulation): SaveData {
  const g = sim.grid;
  const src = sim.sources[0];
  return {
    version: 3,
    width: g.width,
    height: g.height,
    cellSize: sim.params.cellSize,
    savedAt: Date.now(),
    inflow: sim.inflowScale,
    source: src ? { x: src.x, y: src.y, radius: src.radius, maxRate: src.maxRate } : null,
    bed: encodeFloats(g.bedHeight),
    water: encodeFloats(g.waterDepth),
    sediment: encodeFloats(g.suspendedSediment),
    bedload: encodeFloats(g.bedloadSediment),
    bedrock: encodeFloats(g.bedrockHeight),
    erodibility: encodeFloats(g.erodibility),
    secondaryFlow: encodeFloats(g.secondaryFlow),
    lowVelocityAge: encodeFloats(g.lowVelocityAge),
    circulation: { ...sim.circulation },
    circulationWaterByColumn: Array.from(sim.circulationWaterByColumn),
    circulationSuspendedSedimentByColumn: Array.from(sim.circulationSuspendedSedimentByColumn),
    circulationBedloadSedimentByColumn: Array.from(sim.circulationBedloadSedimentByColumn),
    params: { ...sim.params, openBoundary: { ...sim.params.openBoundary } },
    presetId: sim.presetId,
    seed: sim.randomSeed,
  };
}

export function deserialize(sim: Simulation, data: SaveData): void {
  const g = sim.grid;
  const bed = decodeFloats(data.bed);
  const water = decodeFloats(data.water);
  const sediment = decodeFloats(data.sediment);
  resample(bed, data.width, data.height, g.bedHeight, g.width, g.height);
  resample(water, data.width, data.height, g.waterDepth, g.width, g.height);
  resample(sediment, data.width, data.height, g.suspendedSediment, g.width, g.height);
  if (data.bedload) resample(decodeFloats(data.bedload), data.width, data.height, g.bedloadSediment, g.width, g.height);
  else g.bedloadSediment.fill(0);
  if (data.bedrock) resample(decodeFloats(data.bedrock), data.width, data.height, g.bedrockHeight, g.width, g.height);
  if (data.erodibility) resample(decodeFloats(data.erodibility), data.width, data.height, g.erodibility, g.width, g.height);
  if (data.secondaryFlow) resample(decodeFloats(data.secondaryFlow), data.width, data.height, g.secondaryFlow, g.width, g.height);
  else g.secondaryFlow.fill(0);
  if (data.lowVelocityAge) resample(decodeFloats(data.lowVelocityAge), data.width, data.height, g.lowVelocityAge, g.width, g.height);
  else g.lowVelocityAge.fill(0);
  g.velocityX.fill(0);
  g.velocityY.fill(0);
  for (const flux of g.fluxes) flux.fill(0);
  g.curvature.fill(0);
  g.bankSide.fill(0);
  g.oxbowCandidate.fill(0);
  for (let i = 0; i < g.size; i++) {
    if (!Number.isFinite(g.bedHeight[i])) g.bedHeight[i] = 0;
    if (!(g.waterDepth[i] >= 0)) g.waterDepth[i] = 0;
    if (!(g.suspendedSediment[i] >= 0)) g.suspendedSediment[i] = 0;
    if (!(g.bedloadSediment[i] >= 0)) g.bedloadSediment[i] = 0;
    if (g.bedHeight[i] < g.bedrockHeight[i]) g.bedHeight[i] = g.bedrockHeight[i];
  }
  sim.inflowScale = Math.max(0, Math.min(1, data.inflow));
  if (data.params) {
    sim.params = { ...sim.params, ...data.params };
    if (data.params.openBoundary) sim.params.openBoundary = { ...data.params.openBoundary };
  }
  if (data.circulation) {
    Object.assign(sim.circulation, data.circulation);
  } else {
    sim.seedCirculation(0);
  }
  if (data.circulationWaterByColumn?.length) {
    restoreColumns(data.circulationWaterByColumn, sim.circulationWaterByColumn, sim.circulation.water);
  } else sim.circulationWaterByColumn.fill(sim.circulation.water / g.width);
  if (data.circulationSuspendedSedimentByColumn?.length) {
    restoreColumns(
      data.circulationSuspendedSedimentByColumn,
      sim.circulationSuspendedSedimentByColumn,
      sim.circulation.suspendedSediment,
    );
  } else {
    const ratio = sim.circulation.water > 0
      ? sim.circulation.suspendedSediment / sim.circulation.water
      : 0;
    for (let x = 0; x < g.width; x++) {
      sim.circulationSuspendedSedimentByColumn[x] = sim.circulationWaterByColumn[x] * ratio;
    }
  }
  if (data.circulationBedloadSedimentByColumn?.length) {
    restoreColumns(
      data.circulationBedloadSedimentByColumn,
      sim.circulationBedloadSedimentByColumn,
      sim.circulation.bedloadSediment,
    );
  } else {
    const ratio = sim.circulation.water > 0
      ? sim.circulation.bedloadSediment / sim.circulation.water
      : 0;
    for (let x = 0; x < g.width; x++) {
      sim.circulationBedloadSedimentByColumn[x] = sim.circulationWaterByColumn[x] * ratio;
    }
  }
  sim.presetId = data.presetId ?? 'legacy-sandbox';
  sim.randomSeed = data.seed ?? 0;
  if (data.source && sim.sources[0]) {
    const sx = (data.source.x / data.width) * g.width;
    const sy = (data.source.y / data.height) * g.height;
    sim.sources[0].x = Math.max(0, Math.min(g.width - 1, sx));
    sim.sources[0].y = Math.max(0, Math.min(g.height - 1, sy));
    sim.sources[0].radius = Math.max(0.5, (data.source.radius / data.width) * g.width);
    sim.sources[0].maxRate = Math.max(0, data.source.maxRate);
  }
  sim.resetBudget();
}

export function saveToStorage(sim: Simulation): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(sim)));
    return true;
  } catch {
    return false;
  }
}

export function loadFromStorage(sim: Simulation): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== 1 && data.version !== 2) return false;
    deserialize(sim, data);
    return true;
  } catch {
    return false;
  }
}

export function hasSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

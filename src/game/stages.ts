/**
 * お題モードのステージ定義（データのみ）。
 *
 * 座標はすべて 0..1 の正規化座標。格子解像度を端末性能に応じて変えても
 * 同じ地形・同じ判定になる。
 */

import type { StageDef } from './stage.ts';

export const STAGES: StageDef[] = [
  // ------------------------------------------------------------ 1
  {
    id: 'deliver',
    name: '1. 水をゴールへ届ける',
    subtitle: '谷を掘って、水の行き先を変える',
    hint: '水は今、右側の低い方へ逃げている。尾根を削って左下の池へ導こう。',
    terrain: [
      { type: 'slope', high: 6.5, low: 1.0, dir: 'down' },
      { type: 'noise', amplitude: 0.12, scale: 4, seed: 1101 },
      // 盤面を横断する尾根。右端 (0.80 以降) だけ自然に開いている
      { type: 'plateau', x: 0, y: 0.40, w: 0.8, h: 0.10, height: 1.2, blend: 0.03 },
      // 左下の高台。ここを越えないとゴールへ届かない
      { type: 'plateau', x: 0.0, y: 0.58, w: 0.52, h: 0.42, height: 0.9, blend: 0.08 },
      // ゴールの窪地
      { type: 'carve', x: 0.06, y: 0.76, w: 0.30, h: 0.16, height: 2.15, blend: 0.02 },
    ],
    sources: [{ id: 'spring', x: 0.5, y: 0.05, radius: 0.04, maxRate: 1.1 }],
    zones: [
      { id: 'goal', kind: 'goal', label: 'ゴールの池', rect: { x: 0.06, y: 0.76, w: 0.3, h: 0.16 } },
    ],
    openBoundary: { left: false, right: false, top: false, bottom: true },
    sandBudget: 65,
    targetTime: 110,
    timeLimit: 280,
    initialInflow: 0,
    minInflow: 0,
    success: [
      {
        type: 'waterInZone',
        zone: 'goal',
        minDepth: 0.12,
        minCoverage: 0.5,
        sustain: 3,
        label: 'ゴールの池を水で満たす',
      },
    ],
    failure: [{ type: 'timeLimit', seconds: 280, label: '時間切れ' }],
  },

  // ------------------------------------------------------------ 2
  {
    id: 'connect',
    name: '2. 2つの水域をつなぐ',
    subtitle: '尾根を切って、上の池と下の池をつなげる',
    hint: '砂は崩れる。細い溝はすぐ埋まるので、広めに掘り下げること。上の池の水位を上げてから掘ると一気に流れ出す。',
    terrain: [
      { type: 'slope', high: 3.8, low: 2.4, dir: 'down' },
      { type: 'noise', amplitude: 0.1, scale: 5, seed: 2202 },
      { type: 'plateau', x: 0, y: 0.42, w: 1, h: 0.13, height: 0.9, blend: 0.03 },
      { type: 'carve', x: 0.1, y: 0.13, w: 0.32, h: 0.18, height: 2.7, blend: 0.02 },
      { type: 'carve', x: 0.56, y: 0.7, w: 0.34, h: 0.18, height: 1.55, blend: 0.02 },
      { type: 'water', x: 0.1, y: 0.13, w: 0.32, h: 0.18, level: 3.1 },
      { type: 'water', x: 0.56, y: 0.7, w: 0.34, h: 0.18, level: 1.85 },
    ],
    sources: [{ id: 'spring', x: 0.26, y: 0.2, radius: 0.035, maxRate: 0.55 }],
    zones: [
      { id: 'poolA', kind: 'water', label: '上の池', rect: { x: 0.1, y: 0.13, w: 0.32, h: 0.18 } },
      { id: 'poolB', kind: 'water', label: '下の池', rect: { x: 0.56, y: 0.7, w: 0.34, h: 0.18 } },
    ],
    openBoundary: { left: false, right: false, top: false, bottom: false },
    sandBudget: 80,
    targetTime: 170,
    timeLimit: 330,
    initialInflow: 0,
    minInflow: 0,
    success: [
      {
        type: 'connectZones',
        from: 'poolA',
        to: 'poolB',
        minDepth: 0.05,
        sustain: 3,
        label: '2つの池を水路でつなぐ',
      },
    ],
    failure: [{ type: 'timeLimit', seconds: 330, label: '時間切れ' }],
  },

  // ------------------------------------------------------------ 3
  {
    id: 'bypass',
    name: '3. 集落を浸水させずに排水する',
    subtitle: '赤い区域を避けて、水を下の出口へ',
    hint: '集落の手前で流れを二手に分けると浸水しにくい。堤を高くしすぎると溢れる。',
    terrain: [
      { type: 'slope', high: 5.5, low: 0.6, dir: 'down' },
      { type: 'noise', amplitude: 0.14, scale: 4, seed: 3303 },
      // 集落はわずかに高い平地。だが流路の真正面にある
      { type: 'plateau', x: 0.3, y: 0.44, w: 0.3, h: 0.16, height: 0.15, blend: 0.02 },
      { type: 'drain', x: 0, y: 0.96, w: 1, h: 0.04 },
    ],
    sources: [{ id: 'spring', x: 0.5, y: 0.05, radius: 0.045, maxRate: 1.5 }],
    zones: [
      {
        id: 'village',
        kind: 'protected',
        label: '集落（浸水禁止）',
        rect: { x: 0.3, y: 0.44, w: 0.3, h: 0.16 },
      },
      { id: 'exit', kind: 'drain', label: '排水口', rect: { x: 0, y: 0.96, w: 1, h: 0.04 } },
    ],
    openBoundary: { left: false, right: false, top: false, bottom: false },
    sandBudget: 68,
    targetTime: 140,
    timeLimit: 300,
    initialInflow: 0,
    minInflow: 0,
    success: [{ type: 'drainedWater', volume: 90, label: '出口から 90 m³ 排水する' }],
    failure: [
      { type: 'floodLimit', zone: 'village', maxVolume: 2.0, label: '集落が浸水した' },
      { type: 'timeLimit', seconds: 300, label: '時間切れ' },
    ],
  },

  // ------------------------------------------------------------ 4
  {
    id: 'levee',
    name: '4. 限られた砂で洪水を防ぐ',
    subtitle: '上流の水は止まらない。低地の集落を守れ',
    hint: '谷から低地へ水が漏れ込む「切り欠き」がある。砂は 30 m³ だけ。そこを塞げば守れる。',
    terrain: [
      { type: 'slope', high: 4.6, low: 0.5, dir: 'down' },
      { type: 'noise', amplitude: 0.1, scale: 4, seed: 4404 },
      // 自然の谷。水は基本ここを流れて出口へ向かう
      {
        type: 'channel',
        points: [
          [0.46, 0.0],
          [0.4, 0.25],
          [0.34, 0.5],
          [0.3, 0.75],
          [0.32, 1.0],
        ],
        width: 0.1,
        depth: 0.5,
      },
      // 谷の東側にある低地の集落
      { type: 'carve', x: 0.46, y: 0.52, w: 0.3, h: 0.22, height: 1.7, blend: 0.03 },
      // 低地を囲む縁。西側（谷側）だけ切り欠きが開いている
      { type: 'plateau', x: 0.44, y: 0.5, w: 0.34, h: 0.035, height: 0.9, blend: 0.012 },
      { type: 'plateau', x: 0.755, y: 0.5, w: 0.035, h: 0.28, height: 0.9, blend: 0.012 },
      { type: 'plateau', x: 0.44, y: 0.745, w: 0.35, h: 0.035, height: 0.9, blend: 0.012 },
      { type: 'plateau', x: 0.44, y: 0.5, w: 0.035, h: 0.09, height: 0.9, blend: 0.012 },
      { type: 'plateau', x: 0.44, y: 0.66, w: 0.035, h: 0.12, height: 0.9, blend: 0.012 },
      // 谷から低地へ水が漏れ込む切り欠き（プレイヤーが塞ぐ場所）
      {
        type: 'channel',
        points: [
          [0.34, 0.6],
          [0.48, 0.615],
        ],
        width: 0.028,
        depth: 0.45,
      },
      { type: 'drain', x: 0, y: 0.96, w: 1, h: 0.04 },
    ],
    sources: [{ id: 'flood', x: 0.47, y: 0.05, radius: 0.05, maxRate: 2.6 }],
    zones: [
      {
        id: 'lowland',
        kind: 'protected',
        label: '低地の集落（浸水禁止）',
        rect: { x: 0.46, y: 0.52, w: 0.3, h: 0.22 },
      },
      { id: 'exit', kind: 'drain', label: '排水口', rect: { x: 0, y: 0.96, w: 1, h: 0.04 } },
    ],
    openBoundary: { left: false, right: false, top: false, bottom: false },
    sandBudget: 30,
    targetTime: 120,
    timeLimit: 240,
    initialInflow: 0.4,
    minInflow: 0.25,
    success: [{ type: 'drainedWater', volume: 140, label: '出口から 140 m³ 流しきる' }],
    failure: [
      { type: 'floodLimit', zone: 'lowland', maxVolume: 2.0, label: '低地が浸水した' },
      { type: 'timeLimit', seconds: 240, label: '時間切れ' },
    ],
  },

  // ------------------------------------------------------------ 5
  {
    id: 'delta',
    name: '5. 指定区域に土砂を堆積させる',
    subtitle: '水量を調整して、砂山を削り、湖へ運ぶ',
    hint: '水量を上げて砂山を削る。ただし流しすぎると砂は棚を通り抜けて外へ出る。流出計を見て水を絞ろう。',
    terrain: [
      { type: 'slope', high: 5.0, low: 1.2, dir: 'down' },
      { type: 'noise', amplitude: 0.1, scale: 4, seed: 5505 },
      // 上流の砂山（削れやすい）
      { type: 'hill', x: 0.5, y: 0.22, radius: 0.16, height: 2.0 },
      { type: 'erodibility', x: 0.26, y: 0.08, w: 0.48, h: 0.34, value: 1.8 },
      // 中流の平らな棚。ここに砂を積ませる
      { type: 'carve', x: 0.14, y: 0.54, w: 0.72, h: 0.14, height: 2.15, blend: 0.02 },
      // 下流の湖（流れの終着点）
      { type: 'carve', x: 0.2, y: 0.72, w: 0.6, h: 0.2, height: 1.1, blend: 0.03 },
      { type: 'water', x: 0.2, y: 0.72, w: 0.6, h: 0.2, level: 1.5 },
      { type: 'drain', x: 0, y: 0.97, w: 1, h: 0.03 },
    ],
    sources: [{ id: 'spring', x: 0.5, y: 0.05, radius: 0.04, maxRate: 1.9 }],
    zones: [
      {
        id: 'delta',
        kind: 'deposit',
        label: '堆積させる区域',
        rect: { x: 0.18, y: 0.55, w: 0.64, h: 0.12 },
      },
      { id: 'exit', kind: 'drain', label: '排水口', rect: { x: 0, y: 0.97, w: 1, h: 0.03 } },
    ],
    openBoundary: { left: false, right: false, top: false, bottom: false },
    sandBudget: null,
    targetTime: 180,
    timeLimit: 300,
    initialInflow: 0,
    minInflow: 0,
    success: [
      { type: 'sedimentInZone', zone: 'delta', volume: 32, label: '指定区域に 32 m³ 堆積させる' },
    ],
    failure: [
      {
        type: 'sedimentLostLimit',
        volume: 25,
        label: '土砂を流しすぎた（区域を通り過ぎて外へ出た）',
      },
      { type: 'timeLimit', seconds: 300, label: '時間切れ' },
    ],
  },
];

export function findStage(id: string): StageDef | undefined {
  return STAGES.find((s) => s.id === id);
}

/**
 * 画面まわり（HUD・ツールバー・オーバーレイ）。
 * DOM の組み立てと更新だけを行い、シミュレーションの状態は書き換えない。
 */

import {
  BASE_TIME_SCALE,
  BRUSH_SIZES,
  QUALITY_PRESETS,
  SPEEDS,
  type Session,
  type ToolMode,
} from '../game/session.ts';
import { STAGES } from '../game/stages.ts';
import { hasSave } from '../game/saveLoad.ts';
import type { DebugLayer } from '../render/palette.ts';
import { describeInflow, WaterSlider } from './waterSlider.ts';

export interface UIHandlers {
  onStartStage: (id: string) => void;
  onStartSandbox: () => void;
  onStartMeanderSandbox: () => void;
  onReset: () => void;
  onSave: () => void;
  onLoad: () => void;
  onToTitle: () => void;
  onResetCamera: () => void;
  onSourceMoveMode: () => void;
}

const DEBUG_LAYERS: { id: DebugLayer; label: string }[] = [
  { id: 'none', label: '通常' },
  { id: 'height', label: '高さ' },
  { id: 'depth', label: '水深' },
  { id: 'velocity', label: '流速' },
  { id: 'sediment', label: '浮遊土砂' },
  { id: 'erosion', label: '侵食' },
  { id: 'deposition', label: '堆積' },
  { id: 'curvature', label: '曲率' },
  { id: 'secondary', label: '二次流' },
  { id: 'bank', label: '外岸/内岸' },
  { id: 'bedload', label: '掃流砂' },
  { id: 'oxbow', label: '三日月湖' },
];

export class GameUI {
  private session: Session;
  private handlers: UIHandlers;
  slider: WaterSlider;

  private el = {
    hud: byId('hud'),
    stageName: byId('stage-name'),
    stageSub: byId('stage-sub'),
    time: byId('hud-time'),
    objectives: byId('objectives'),
    meters: byId('meters'),
    toolbar: byId('toolbar'),
    brushSeg: byId('brush-seg'),
    speedSeg: byId('speed-seg'),
    sandBar: byId('sand-bar'),
    overlay: byId('overlay'),
    toast: byId('toast'),
    viewBtn: byId('btn-view') as HTMLButtonElement,
  };
  private debugPanel: HTMLElement;
  private toastTimer = 0;
  /** 水源の位置を移動するモード（自由モード用） */
  sourceMoveMode = false;

  constructor(session: Session, handlers: UIHandlers) {
    this.session = session;
    this.handlers = handlers;
    this.slider = new WaterSlider(byId('water-slider'));

    this.debugPanel = document.createElement('div');
    this.debugPanel.className = 'debug-panel';
    this.debugPanel.hidden = true;
    byId('app').appendChild(this.debugPanel);

    this.buildSegments();
    this.bindTools();
    byId('btn-menu').addEventListener('click', () => this.openMenu());
    this.el.viewBtn.addEventListener('click', () => {
      session.view = session.view === 'top' ? 'oblique' : 'top';
      this.el.viewBtn.textContent = session.view === 'top' ? '斜め視点' : '真上視点';
      this.toast(session.view === 'top' ? '真上から見ています' : '斜めから見ています');
    });
  }

  // ------------------------------------------------------------ 構築

  private buildSegments(): void {
    this.el.brushSeg.innerHTML = '';
    BRUSH_SIZES.forEach((b, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        this.session.brushIndex = i;
        this.syncSegments();
      });
      this.el.brushSeg.appendChild(btn);
    });

    this.el.speedSeg.innerHTML = '';
    SPEEDS.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = i === 0 ? '⏸' : s.label.replace('倍', '×');
      btn.addEventListener('click', () => {
        this.session.speedIndex = i;
        this.syncSegments();
      });
      this.el.speedSeg.appendChild(btn);
    });
    this.syncSegments();
  }

  private bindTools(): void {
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]'))) {
      btn.addEventListener('click', () => {
        this.session.tool = btn.dataset.tool as ToolMode;
        this.sourceMoveMode = false;
        this.syncTools();
      });
    }
    this.syncTools();
  }

  private syncTools(): void {
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]'))) {
      btn.classList.toggle('active', btn.dataset.tool === this.session.tool);
    }
  }

  private syncSegments(): void {
    Array.from(this.el.brushSeg.children).forEach((c, i) =>
      c.classList.toggle('active', i === this.session.brushIndex),
    );
    Array.from(this.el.speedSeg.children).forEach((c, i) =>
      c.classList.toggle('active', i === this.session.speedIndex),
    );
  }

  syncAll(): void {
    this.syncTools();
    this.syncSegments();
    this.slider.setMin(this.session.activeStage.minInflow);
    this.slider.set(this.session.inflow, false);
    this.slider.setCirculationMode(this.session.sim.params.circulationEnabled);
    this.el.viewBtn.textContent = this.session.view === 'top' ? '斜め視点' : '真上視点';
  }

  // ------------------------------------------------------------ 更新

  update(): void {
    const s = this.session;
    const stage = s.activeStage;
    this.el.stageName.textContent = stage.name;
    this.el.stageSub.textContent =
      s.mode === 'stage' ? stage.subtitle : `${describeInflow(s.inflow)}・${stage.subtitle}`;

    const t = s.sim.elapsed;
    const limit = stage.timeLimit;
    const shown = limit ? Math.max(0, limit - t) : t;
    this.el.time.textContent = formatTime(shown);
    this.el.time.style.color = limit && limit - t < 20 ? '#ff8080' : '';

    this.renderObjectives();
    this.renderMeters();
    this.renderSandBar();
    this.renderDebug();
  }

  private renderObjectives(): void {
    const tracker = this.session.world.tracker;
    const box = this.el.objectives;
    if (!tracker || this.session.mode !== 'stage') {
      box.innerHTML = '';
      return;
    }
    const rows = [
      ...tracker.successStates.map((st) => ({ st, warn: false })),
      ...tracker.failureStates
        .filter((st) => st.progress > 0.35)
        .map((st) => ({ st, warn: true })),
    ];
    box.innerHTML = '';
    for (const { st, warn } of rows) {
      const div = document.createElement('div');
      div.className = 'obj' + (st.satisfied && !warn ? ' done' : '') + (warn ? ' warn' : '');
      div.innerHTML = `<span class="dot"></span><span class="lbl"></span><span class="val"></span>`;
      (div.querySelector('.lbl') as HTMLElement).textContent = st.label;
      (div.querySelector('.val') as HTMLElement).textContent = st.detail;
      box.appendChild(div);
    }
  }

  private renderMeters(): void {
    const s = this.session;
    const sim = s.sim;
    const st = sim.stats;
    const items: string[] = [];
    items.push(`${sim.params.circulationEnabled ? '循環流量' : '流入'} <b>${sim.currentInflow().toFixed(2)}</b> m³/s`);
    items.push(`水量 <b>${st.waterVolume.toFixed(1)}</b> m³`);
    items.push(`浮遊土砂 <b>${suspended(sim).toFixed(2)}</b> m³`);
    items.push(`流失 <b>${sim.budget.waterOut.toFixed(0)}</b> m³`);
    if (s.mode === 'stage' && s.world.tracker) {
      const m = s.world.tracker.metrics;
      if (s.activeStage.zones.some((z) => z.kind === 'protected')) {
        items.push(`浸水 <b>${m.floodVolume.toFixed(2)}</b> m³`);
      }
      if (s.activeStage.zones.some((z) => z.kind === 'deposit')) {
        items.push(`堆積 <b>${m.depositVolume.toFixed(1)}</b> m³`);
        items.push(`土砂流出 <b>${m.sedimentLost.toFixed(1)}</b> m³`);
      }
    }
    this.el.meters.innerHTML = items.map((t) => `<span class="meter">${t}</span>`).join('');
  }

  private renderSandBar(): void {
    const s = this.session;
    const b = s.sim.budget;
    const remaining = s.sandRemaining;
    const left =
      remaining === null
        ? '砂：無制限'
        : `残りの砂 <b>${remaining.toFixed(1)}</b> / ${s.activeStage.sandBudget?.toFixed(0)} m³`;
    this.el.sandBar.innerHTML =
      `<span>${left}</span>` +
      `<span>盛った <b>${b.sandAdded.toFixed(1)}</b> ・ 削った <b>${b.sandRemoved.toFixed(1)}</b> m³</span>`;
  }

  private renderDebug(): void {
    const s = this.session;
    this.debugPanel.hidden = !s.showDebug;
    if (!s.showDebug) return;
    const sim = s.sim;
    const st = sim.stats;
    const b = sim.budget;
    const wErr = st.waterError;
    const sErr = st.sedimentError;
    const bad = (v: number, scale: number) =>
      Math.abs(v) / Math.max(1, scale) > 1e-4 ? 'bad' : '';
    this.debugPanel.innerHTML = `
      <div><b>${s.perf.fps.toFixed(0)} fps</b> ・ sim ${s.perf.simMs.toFixed(1)}ms ・ draw ${s.perf.renderMs.toFixed(1)}ms</div>
      <div>格子 ${sim.grid.width}×${sim.grid.height} (${s.perf.quality}) ・ step/frame ${s.perf.stepsPerFrame} ・ sub ${st.substeps} ・ 描画 ${(s.renderScale * 100).toFixed(0)}%</div>
      <div>指定 ${SPEEDS[s.speedIndex].label} ・ 実効 <b>${effectiveSpeed(s).toFixed(2)}倍</b></div>
      <div>水 <b>${st.waterVolume.toFixed(2)}</b> m³ ・ 追加 ${b.waterAdded.toFixed(1)} ・ 流出 ${b.waterOut.toFixed(1)}</div>
      <div>循環槽 水 ${st.circulationWater.toFixed(2)} m³ ・ 土砂 ${st.circulationSediment.toFixed(3)} m³ ・ 累積循環 ${b.waterCirculated.toFixed(1)} m³</div>
      <div class="${bad(wErr, st.waterVolume + st.circulationWater)}">水収支誤差 ${wErr.toExponential(2)} m³</div>
      <div>土砂 <b>${st.sedimentVolume.toFixed(1)}</b> m³ ・ 掃流 ${st.bedloadVolume.toFixed(3)} ・ 盛 ${b.sandAdded.toFixed(1)} ・ 削 ${b.sandRemoved.toFixed(1)} ・ 流出 ${b.sedimentOut.toFixed(2)}</div>
      <div class="${bad(sErr, st.sedimentVolume + st.circulationSediment)}">土砂収支誤差 ${sErr.toExponential(2)} m³</div>
      <div>侵食 ${st.erodedVolume.toFixed(4)} ・ 堆積 ${st.depositedVolume.toFixed(4)} m³/frame</div>
      <div>最大水深 ${st.maxDepth.toFixed(3)} m ・ 最大流速 ${st.maxSpeed.toFixed(2)} m/s ・ 濡れ ${st.wetCells}</div>
      <div>蛇行度 ${st.sinuosity.toFixed(3)} ・ 三日月湖候補 ${st.oxbowCandidates}</div>
      <div class="${b.numericFaults > 0 ? 'bad' : ''}">数値破綻 ${b.numericFaults}</div>
      <div>地形変化倍率 ${sim.params.morphologicalTimeScale.toFixed(1)}</div>`;
  }

  // ------------------------------------------------------------ 画面

  toast(message: string): void {
    const el = this.el.toast;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 2200);
  }

  private show(html: string): HTMLElement {
    this.el.overlay.innerHTML = `<div class="sheet">${html}</div>`;
    this.el.overlay.classList.add('open');
    return this.el.overlay.firstElementChild as HTMLElement;
  }

  close(): void {
    this.el.overlay.classList.remove('open');
    this.el.overlay.innerHTML = '';
  }

  get isOverlayOpen(): boolean {
    return this.el.overlay.classList.contains('open');
  }

  openTitle(): void {
    const sheet = this.show(`
      <h1>River</h1>
      <p>水と砂で川をつくるシミュレーション。<br />
      あなたが操作するのは「砂の高低差」と「水源の水量」の2つだけ。
      水は地形に沿って流れ、強い流れは砂を削り、弱い流れは砂を積もらせます。
      その結果できた地形が、次の水の流れを変えます。</p>
      <h2>お題モード</h2>
      <div id="stage-list"></div>
      <h2>自由モード</h2>
      <button class="big-btn primary" data-act="sandbox">箱庭をはじめる
        <small>制限なし。保存・読み込み・水源の移動ができます</small></button>
      <button class="big-btn" data-act="meander">蛇行観察をはじめる
        <small>長い氾濫原で有限の水と砂が上下循環します</small></button>
      ${hasSave() ? '<button class="big-btn" data-act="load">保存した地形を読み込む</button>' : ''}
      <h2>操作</h2>
      <p>・指1本でなぞる：砂を盛る／削る（長く押すほど大きく変化）<br />
      ・指2本：視点の移動と拡大縮小<br />
      ・右端の縦スライダー：水源から流れ込む量</p>
    `);
    const list = sheet.querySelector('#stage-list') as HTMLElement;
    for (const stage of STAGES) {
      const btn = document.createElement('button');
      btn.className = 'big-btn';
      btn.type = 'button';
      btn.innerHTML = `${stage.name}<small>${stage.subtitle}${
        stage.sandBudget !== null ? ` ・ 砂 ${stage.sandBudget} m³` : ''
      }${stage.timeLimit ? ` ・ 制限 ${Math.round(stage.timeLimit)}秒` : ''}</small>`;
      btn.addEventListener('click', () => this.handlers.onStartStage(stage.id));
      list.appendChild(btn);
    }
    sheet.querySelector('[data-act="sandbox"]')?.addEventListener('click', () =>
      this.handlers.onStartSandbox(),
    );
    sheet.querySelector('[data-act="meander"]')?.addEventListener('click', () =>
      this.handlers.onStartMeanderSandbox(),
    );
    sheet.querySelector('[data-act="load"]')?.addEventListener('click', () => {
      this.handlers.onStartSandbox();
      this.handlers.onLoad();
    });
  }

  openMenu(): void {
    const s = this.session;
    const sandbox = s.mode === 'sandbox';
    const sheet = this.show(`
      <h1>メニュー</h1>
      <p>${s.activeStage.hint}</p>
      <button class="big-btn primary" data-act="close">ゲームに戻る</button>
      <div class="row-btns">
        <button class="big-btn" data-act="reset">地形を初期化</button>
        <button class="big-btn" data-act="camera">視点をリセット</button>
        ${sandbox ? '<button class="big-btn" data-act="save">地形を保存</button>' : ''}
        ${sandbox && hasSave() ? '<button class="big-btn" data-act="load">地形を読み込む</button>' : ''}
        ${sandbox ? '<button class="big-btn" data-act="source">水源の位置を変える</button>' : ''}
        <button class="big-btn" data-act="title">タイトルへ戻る</button>
      </div>
      <h2>表示・開発用設定</h2>
      <div class="switch-row"><span>デバッグ表示</span>
        <div class="seg" id="dbg-layers"></div></div>
      <div class="switch-row"><span>流速ベクトル</span>
        <div class="seg" id="dbg-vel"></div></div>
      <div class="switch-row"><span>収支・負荷パネル</span>
        <div class="seg" id="dbg-panel"></div></div>
      <div class="switch-row"><span>地形変化の倍率</span>
        <div class="seg" id="morph-seg"></div></div>
      <div class="switch-row"><span>格子解像度</span>
        <div class="seg" id="quality-seg"></div></div>
      <p>解像度を変えると地形は作り直されます。</p>
    `);

    sheet.querySelector('[data-act="close"]')?.addEventListener('click', () => this.close());
    sheet.querySelector('[data-act="reset"]')?.addEventListener('click', () => {
      this.handlers.onReset();
      this.close();
      this.toast('地形を初期化しました');
    });
    sheet.querySelector('[data-act="camera"]')?.addEventListener('click', () => {
      this.handlers.onResetCamera();
      this.close();
    });
    sheet.querySelector('[data-act="save"]')?.addEventListener('click', () => {
      this.handlers.onSave();
      this.close();
    });
    sheet.querySelector('[data-act="load"]')?.addEventListener('click', () => {
      this.handlers.onLoad();
      this.close();
    });
    sheet.querySelector('[data-act="source"]')?.addEventListener('click', () => {
      this.handlers.onSourceMoveMode();
      this.close();
    });
    sheet.querySelector('[data-act="title"]')?.addEventListener('click', () => {
      this.close();
      this.handlers.onToTitle();
    });

    // デバッグレイヤー
    const layers = sheet.querySelector('#dbg-layers') as HTMLElement;
    for (const l of DEBUG_LAYERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = l.label;
      b.classList.toggle('active', s.debugLayer === l.id);
      b.addEventListener('click', () => {
        s.debugLayer = l.id;
        Array.from(layers.children).forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
      });
      layers.appendChild(b);
    }

    toggleSeg(sheet.querySelector('#dbg-vel') as HTMLElement, s.showVelocity, (v) => {
      s.showVelocity = v;
    });
    toggleSeg(sheet.querySelector('#dbg-panel') as HTMLElement, s.showDebug, (v) => {
      s.showDebug = v;
    });

    const morph = sheet.querySelector('#morph-seg') as HTMLElement;
    for (const v of [0.5, 1, 2, 4, 10]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${v}×`;
      b.classList.toggle('active', s.morphScale === v);
      b.addEventListener('click', () => {
        s.morphScale = v;
        s.applyMorphScale();
        Array.from(morph.children).forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
      });
      morph.appendChild(b);
    }

    const quality = sheet.querySelector('#quality-seg') as HTMLElement;
    QUALITY_PRESETS.forEach((q, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${q.label} ${q.width}×${q.height}`;
      b.classList.toggle('active', s.qualityIndex === i);
      b.addEventListener('click', () => {
        if (s.qualityIndex === i) return;
        s.qualityIndex = i;
        this.handlers.onReset();
        Array.from(quality.children).forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
        this.toast(`格子解像度を「${q.label}」にしました`);
      });
      quality.appendChild(b);
    });
  }

  openResult(cleared: boolean, reason: string): void {
    const s = this.session;
    const tracker = s.world.tracker;
    const m = tracker?.metrics;
    const stars = tracker?.result.stars ?? 0;
    const stage = s.activeStage;
    const next = STAGES[STAGES.findIndex((x) => x.id === stage.id) + 1];
    const sheet = this.show(`
      <h1>${cleared ? 'クリア！' : '失敗'}</h1>
      ${cleared ? `<div class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</div>` : `<p>${reason}</p>`}
      <h2>評価</h2>
      <p>
        目標達成度 <b>${((m?.achievement ?? 0) * 100).toFixed(0)}%</b><br />
        かかった時間 <b>${formatTime(m?.elapsed ?? 0)}</b>（目標 ${formatTime(stage.targetTime)}）<br />
        使用した砂 <b>${(m?.sandUsed ?? 0).toFixed(1)} m³</b>${
          stage.sandBudget !== null ? `（上限 ${stage.sandBudget} m³）` : ''
        }<br />
        浸水禁止区域への流入 <b>${(m?.floodVolume ?? 0).toFixed(2)} m³</b><br />
        流失した水量 <b>${(m?.waterLost ?? 0).toFixed(0)} m³</b><br />
        指定区域への堆積 <b>${(m?.depositVolume ?? 0).toFixed(1)} m³</b>
      </p>
      <div class="row-btns">
        <button class="big-btn primary" data-act="retry">もう一度</button>
        ${cleared && next ? `<button class="big-btn" data-act="next">次のステージへ</button>` : ''}
        <button class="big-btn" data-act="title">タイトルへ</button>
      </div>
    `);
    sheet.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      this.close();
      this.handlers.onStartStage(stage.id);
    });
    sheet.querySelector('[data-act="next"]')?.addEventListener('click', () => {
      this.close();
      if (next) this.handlers.onStartStage(next.id);
    });
    sheet.querySelector('[data-act="title"]')?.addEventListener('click', () => {
      this.close();
      this.handlers.onToTitle();
    });
  }
}

function toggleSeg(root: HTMLElement, initial: boolean, onChange: (v: boolean) => void): void {
  const options: [string, boolean][] = [
    ['オフ', false],
    ['オン', true],
  ];
  for (const [label, value] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('active', initial === value);
    b.addEventListener('click', () => {
      onChange(value);
      Array.from(root.children).forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
    });
    root.appendChild(b);
  }
}

function suspended(sim: { grid: { size: number; suspendedSediment: Float32Array }; cellArea: number }): number {
  let s = 0;
  for (let i = 0; i < sim.grid.size; i++) s += sim.grid.suspendedSediment[i];
  return s * sim.cellArea;
}

/**
 * 実際に出ている倍速。
 * 端末が指定倍速に追いつけない場合はこの値が下回る（計算は壊れずゆっくり進む）。
 */
function effectiveSpeed(s: Session): number {
  const simSecondsPerRealSecond = s.perf.stepsPerFrame * s.perf.fps * s.sim.params.fixedDt;
  return simSecondsPerRealSecond / BASE_TIME_SCALE;
}

function formatTime(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: #${id}`);
  return el;
}

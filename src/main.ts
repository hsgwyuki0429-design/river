/**
 * エントリポイント。ゲームループと各モジュールの結線。
 *
 * シミュレーションは固定時間刻みで進め、描画は必要に応じて間引く。
 * （高負荷時は描画の間引き → サブステップ削減 → 描画解像度の低下、の順で段階的に軽くする）
 */

import './style.css';
import { Session } from './game/session.ts';
import { SANDBOX_STAGE } from './game/world.ts';
import { Renderer } from './render/renderer.ts';
import { BoardInput } from './ui/input.ts';
import { GameUI } from './ui/ui.ts';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const session = new Session();
const renderer = new Renderer(canvas);
const input = new BoardInput(canvas, renderer, session);

const ui = new GameUI(session, {
  onStartStage: (id) => {
    session.startStage(id);
    input.resetCamera();
    ui.syncAll();
    ui.close();
    ui.toast(session.activeStage.hint);
  },
  onStartSandbox: () => {
    session.startSandbox();
    input.resetCamera();
    ui.syncAll();
    ui.close();
  },
  onStartMeanderSandbox: () => {
    session.startMeanderSandbox();
    input.resetCamera();
    ui.syncAll();
    ui.close();
    ui.toast('有限の水を循環させています');
  },
  onReset: () => {
    // 解像度が変わっている場合は作り直す
    if (session.mode === 'sandbox' && session.activeStage.id === 'meander-sandbox') {
      session.startMeanderSandbox();
    } else if (session.mode === 'sandbox') session.startSandbox();
    else if (session.stage) session.startStage(session.stage.id);
    else session.reset();
    ui.syncAll();
  },
  onSave: () => ui.toast(session.save() ? '地形を保存しました' : '保存できませんでした'),
  onLoad: () => {
    const ok = session.load();
    ui.syncAll();
    ui.toast(ok ? '地形を読み込みました' : '保存データがありません');
  },
  onToTitle: () => {
    session.toTitle();
    ui.openTitle();
  },
  onResetCamera: () => input.resetCamera(),
  onSourceMoveMode: () => {
    ui.toast('水源を置きたい場所をタップしてください');
    input.interceptTap = (cell) => {
      const src = session.sim.sources[0];
      if (src) {
        src.x = cell.x;
        src.y = cell.y;
        ui.toast('水源を移動しました');
      }
    };
  },
});

ui.slider.onChange = (v) => session.setInflow(v);
input.onOutOfSand = () => ui.toast('使える砂がなくなりました');

// ------------------------------------------------------------ リサイズ

function resize(): void {
  const vv = window.visualViewport;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * session.renderScale;
  renderer.resize(w, h, dpr);
  updateInsets();
}

/** HUD・ツールバー・スライダーに盤面が隠れないよう余白を測る */
function updateInsets(): void {
  const hud = document.getElementById('hud');
  const toolbar = document.getElementById('toolbar');
  const slider = document.getElementById('water-slider');
  // スライダーの目盛り側は盤面に重ねてよい（幅を稼ぐため）
  renderer.insets = {
    top: (hud?.offsetHeight ?? 0) + 4,
    bottom: (toolbar?.offsetHeight ?? 0) + 4,
    left: 6,
    right: Math.round((slider?.offsetWidth ?? 0) * 0.6) + 12,
  };
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
resize();

// ------------------------------------------------------------ ループ

let last = performance.now();
let frame = 0;
let lastRenderScale = session.renderScale;
let resultShown = false;

function loop(now: number): void {
  const frameStart = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame++;

  const overlayOpen = ui.isOverlayOpen;
  const active = session.mode !== 'title' && !overlayOpen;

  if (active) {
    input.update(dt);
    session.update(dt);
  }

  // 描画は 30fps を下回りそうなときだけ間引く
  const skipRender = session.perf.fps < 34 && frame % 2 === 1;
  if (!skipRender) {
    const t0 = performance.now();
    renderer.superSample = session.superSample;
    renderer.render(session.sim, {
      view: session.view,
      debugLayer: session.debugLayer,
      showVelocity: session.showVelocity,
      zones: session.activeStage.zones,
      brush: input.cursor,
      sources: session.sim.sources,
    });
    session.perf.renderMs = performance.now() - t0;
  }

  if (session.mode !== 'title') {
    ui.update();
    if (frame % 30 === 0) updateInsets();
  }

  // お題の達成／失敗
  const tracker = session.world.tracker;
  if (active && tracker && session.mode === 'stage') {
    const r = tracker.result;
    if ((r.cleared || r.failed) && !resultShown) {
      resultShown = true;
      ui.openResult(r.cleared, r.failReason);
    }
  }
  if (!tracker || session.mode !== 'stage') resultShown = false;
  else if (!tracker.result.cleared && !tracker.result.failed) resultShown = false;

  session.adaptPerformance(performance.now() - frameStart);
  if (session.renderScale !== lastRenderScale) {
    lastRenderScale = session.renderScale;
    resize();
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------ 起動

// index.html の起動ガードへ「JS が動いた」ことを伝える
document.documentElement.setAttribute('data-booted', '');

session.startSandbox();
session.mode = 'title';
ui.syncAll();
ui.openTitle();
requestAnimationFrame(loop);

// 初期地形をタイトル背景として見せるため、少しだけ水を流しておく
session.sim.inflowScale = SANDBOX_STAGE.initialInflow;
for (let i = 0; i < 240; i++) session.sim.step(session.sim.params.fixedDt);
session.sim.inflowScale = session.inflow;

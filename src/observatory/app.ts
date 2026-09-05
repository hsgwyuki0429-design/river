import './style.css';
import { RiverModel, PRESETS, SAVE_KEY, STEP, END_YEAR, decodeSave, length, sinuosity, type RiverState } from './model.ts';
import { Landscape, type Layers } from './renderer.ts';
import { flatTerrain, paintTerrain, type TerrainField, type TerrainTool } from './terrain.ts';
import { TerrainInput } from './terrain-input.ts';

const icon = (name: string, size = 20) => {
  const paths: Record<string, string> = {
    river: '<path d="M8 2c-8 6 12 8 4 14s0 6 3 6M15 2C7 8 27 10 19 16s0 6 3 6"/>',
    play: '<path d="m9 5 11 7-11 7z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    drop: '<path d="M12 2C8 8 5 11 5 15a7 7 0 0 0 14 0c0-4-3-7-7-13Z"/>',
    save: '<path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/>',
    camera: '<path d="M3 7h5l2-3h4l2 3h5v13H3z"/><circle cx="12" cy="13" r="4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
};
document.getElementById('app')!.innerHTML = `
  <header class="masthead">
    <a class="brand" href="./" aria-label="River ホーム">${icon('river', 29)}<span>river<span class="brand-dot">.</span></span></a>
    <span class="masthead-caption">川が、風景をつくる。</span>
    <nav aria-label="アプリメニュー"><button id="about" class="text-button">${icon('info', 17)}<span>このモデルについて</span></button><a class="workshop-link" href="?mode=sandbox">砂の実験室 ↗</a></nav>
  </header>
  <main class="observatory">
    <aside class="sidebar">
      <div class="intro"><p class="eyebrow">A RIVER THROUGH TIME</p><h1>川の、<br>長い時間を。</h1><p class="intro-copy">曲がり、ほどけ、また流れる。<br>自然な川の移り変わりを、早送りで。</p></div>
      <section class="settings" aria-label="川の設定"><div class="section-heading"><h2>観察する川</h2><span>01 — FIELD</span></div>
        <label class="sr-only" for="preset">川の環境</label><select id="preset">${PRESETS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
        <p id="preset-description" class="field-description">${PRESETS[0].description}</p>
        <div class="range-heading"><label for="flow">水の量</label><output id="flow-value" for="flow">1.0 ×</output></div>
        <input id="flow" type="range" min="0.5" max="1.8" step="0.05" value="1" /><div class="range-captions"><span>少ない</span><span>多い</span></div>
        <div class="range-heading"><label for="erosion">川岸の変わりやすさ</label><output id="erosion-value" for="erosion">1.0 ×</output></div>
        <input id="erosion" type="range" min="0.3" max="1.8" step="0.05" value="1" /><div class="range-captions"><span>かたい</span><span>やわらかい</span></div>
        <button id="flood" class="flood-button">${icon('drop', 17)}<span>20 年間、増水させる</span><span>↗</span></button>
        <p id="history-hint" class="field-description" hidden>過去を観察中。最新に戻ると設定を変えられます。</p>
      </section>
      <section class="layers" aria-label="表示するもの"><div class="section-heading"><h2>風景に重ねる</h2><span>02 — LAYERS</span></div>
        <label><span><i class="legend-trail"></i>過去の流路</span><input id="trails" type="checkbox" checked role="switch" /></label>
        <label><span><i class="legend-flow"></i>流れの向き</span><input id="flow-layer" type="checkbox" checked role="switch" /></label>
        <label><span><i class="legend-land"></i>地形のテクスチャ</span><input id="terrain" type="checkbox" checked role="switch" /></label>
      </section>
      <div class="sidebar-bottom"><button id="reset" class="text-button">${icon('reset', 16)}はじめから</button><button id="save" class="text-button">${icon('save', 16)}保存</button><button id="load" class="text-button">復元</button></div>
      <p class="model-note">仮想の氾濫原 / 学習用の概念モデル<br>年数は変化の目安で、実河川の予測ではありません。</p>
    </aside>
    <section class="workspace" aria-label="川の変遷を観察">
      <div class="workspace-heading"><div><span class="eyebrow">LIVE LANDSCAPE</span><h2 id="field-title">草原の川 <span>— 自由に流れる氾濫原</span></h2></div><button id="capture" class="icon-button" aria-label="風景を画像として保存" title="風景を画像として保存">${icon('camera')}</button></div>
      <section class="terrain-controls" aria-label="地形の編集">
        <div class="terrain-tools" role="group" aria-label="地形の道具">
          <button id="tool-observe" aria-pressed="true">観察</button><button id="tool-raise" aria-pressed="false">盛る ＋</button><button id="tool-lower" aria-pressed="false">削る −</button><button id="tool-restore" aria-pressed="false">ならす</button>
        </div>
        <label>ブラシ<select id="terrain-radius"><option value="80">小</option><option value="140" selected>中</option><option value="240">大</option></select></label>
        <label>強さ<select id="terrain-strength"><option value="0.5">0.5 m</option><option value="1.5" selected>1.5 m</option><option value="3">3 m</option></select></label>
        <button id="terrain-undo" disabled>ひと筆戻す</button><button id="terrain-clear">地形を戻す</button>
        <p id="terrain-hint">盛る・削るで地形をなぞり、再生すると川の変化を観察できます。</p>
      </section>
      <div class="map-wrap"><canvas id="landscape" role="img" tabindex="0" aria-describedby="terrain-hint" aria-label="蛇行する川と、過去の流路・三日月湖の俯瞰図"></canvas>
        <div class="map-top"><span class="live-badge"><i></i><span id="live-label">観察中</span></span><span class="map-location">仮想の氾濫原 <span>/</span> <span id="seed-label">042</span></span></div>
        <div class="north-mark" aria-hidden="true"><span>N</span><svg width="16" height="33" viewBox="0 0 16 33"><path d="M8 0 1 22l7-5 7 5Z" fill="#53634e"/><path d="M8 4v27" stroke="#53634e"/></svg></div>
        <div class="map-legend"><span><i class="water-dot"></i>本流</span><span><i class="sand-dot"></i>内岸の砂州</span><span><i class="oxbow-dot"></i>旧流路・三日月湖</span></div>
        <div id="event" class="event" role="status" hidden></div>
        <div class="elevation-key"><span>低く</span><i></i><span>高く</span><output id="elevation-range">−12 ～ +12 m</output><span>初期地形からの変更量</span></div>
      </div>
      <div class="transport"><div class="playback-row"><button id="play" class="play-button" aria-label="一時停止">${icon('pause')}</button><div class="year-block"><output id="year">0</output><span>年経過</span></div><div class="speed-control"><label for="speed">早送り</label><select id="speed"><option value="5">5 年 / 秒</option><option value="20" selected>20 年 / 秒</option><option value="80">80 年 / 秒</option></select></div><button id="latest" class="text-button" hidden>最新へ ${icon('arrow', 15)}</button><button id="advance" class="advance-button">100 年進める ${icon('arrow', 16)}</button></div>
        <div class="timeline-wrap"><input id="timeline" type="range" min="0" max="0" value="0" step="1" aria-label="過去の流路を観察する時間" /><div class="timeline-labels"><span id="timeline-start">0 年</span><span id="timeline-hint">時間を戻して、川の記憶をたどる</span><span id="timeline-end">0 年</span></div></div>
      </div>
      <div class="insights"><div class="stat"><span>流路の長さ</span><strong id="length">2.2 <small>km</small></strong></div><div class="stat"><span>蛇行度 <span title="流路の長さ ÷ 上流と下流を結ぶ直線距離">ⓘ</span></span><strong id="sinuosity">1.20 <small>倍</small></strong></div><div class="stat"><span>生まれた三日月湖</span><strong id="oxbows">0 <small>か所</small></strong></div><div class="observation"><span class="eyebrow">FIELD NOTES</span><p id="note">外側の岸が削れ、内側に砂がたまる。<br>小さな曲がりが、ゆっくり育っていきます。</p></div></div>
    </section>
  </main>
  <dialog id="about-dialog"><button id="close-about" class="dialog-close" aria-label="説明を閉じる">×</button><p class="eyebrow">ABOUT THIS LANDSCAPE</p><h2>川の一生を、観察する。</h2><p>これは実在の川の昔の映像ではなく、自由に蛇行する川の変遷を計算するアプリです。再生すると川岸が動き、蛇行の首がつながると短い流路へ切り替わり、旧流路が三日月湖として残ります。</p><p>「盛る」「削る」で地形をなぞれます。「ならす」はなぞった場所を初期の高さへ近づけます。茶色は盛った場所、青緑は掘った場所で、輪郭線は高さの変更量が2 m刻みの線です。編集後に再生すると、高くした岸は動きにくく、低地へ川が寄る様子を観察できます。矢印キーでブラシ位置を移動し、Enterでも編集できます。</p><p>曲率と上流からの影響で河道を移動させる Howard–Knutson 系モデルに、編集した地形の勾配と高い岸への抵抗を加えています。川の形は毎回計算され、切断の時刻は決められていません。</p><p>表示年数・流量倍率は未校正の目安です。地形の変更量を計算に使いますが、水深、洪水の浸水域、土砂収支は解きません。盛った地形の侵食や決壊を再現する機能ではありません。砂州・矢印・旧流路の緑化・背景の細い模様は理解を助ける表現です。</p><p>「保存」は現在の川と編集した地形を保存します。復元後の時間軸は保存時点から始まります。編集前後の地形は、この観察中の時間軸で見比べられます。</p><a href="https://doi.org/10.1029/WR020i011p01659" target="_blank" rel="noreferrer">モデルの参考文献 ↗</a><p class="dialog-tip">Space：再生 / 一時停止 · 時間軸：過去を観察 · 再生：過去から続けて見る</p></dialog>
  <div id="notification" role="status" hidden></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const range = (id: string) => $<HTMLInputElement>(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let model = new RiverModel(), seed = 42;
let history: RiverState[] = [model.snapshot()], viewIndex = 0;
let playing = !reducedMotion, speed = 20, accumulator = 0, replayYear = 0, targetYear: number | null = null;
let last = performance.now(), lastUi = 0, motion = 0, lastCutoffs = 0, dirty = true;
let toastTimer = 0;
const layers: Layers = { trails: true, flow: true, terrain: true };
const landscape = new Landscape($<HTMLCanvasElement>('landscape'));
const isHistory = () => viewIndex < history.length - 1;
const displayed = () => isHistory() ? history[viewIndex] : model.state;
let strokeBefore: RiverState | null = null;
let terrainUndo: TerrainField[] = [];
const terrainInput = new TerrainInput(landscape, {
  canEdit: () => !playing && !isHistory() && model.state.year < END_YEAR,
  begin: () => { strokeBefore = model.snapshot(); },
  paint: (points, radius, tool) => { model.state.terrain = paintTerrain(model.state.terrain, points, radius, Number($<HTMLSelectElement>('terrain-strength').value), tool); dirty = true; },
  finish: cancelled => {
    if (!strokeBefore) return;
    if (cancelled) { model.state.terrain = strokeBefore.terrain; dirty = true; }
    else if (model.state.terrain !== strokeBefore.terrain) {
      terrainUndo.push(strokeBefore.terrain); terrainUndo = terrainUndo.slice(-20);
      history.push(strokeBefore, model.snapshot()); viewIndex = history.length - 1;
      notify('地形を変更しました。再生すると川が新しい地形に応じて動きます');
    }
    strokeBefore = null; sync();
  },
  changed: () => { dirty = true; },
});

function notify(message: string): void {
  $('notification').textContent = message; $('notification').hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { $('notification').hidden = true; }, 3800);
}
function sync(): void {
  const s = displayed(), past = isHistory(), ended = model.state.year >= END_YEAR && !past;
  $('year').textContent = Math.floor(s.year).toLocaleString('ja-JP');
  $('length').innerHTML = `${(length(s.points) / 1000).toFixed(2)} <small>km</small>`;
  $('sinuosity').innerHTML = `${sinuosity(s.points).toFixed(2)} <small>倍</small>`;
  $('oxbows').innerHTML = `${s.cutoffs} <small>か所</small>`;
  const flooded = s.year < s.floodUntil;
  $('live-label').textContent = past ? '過去を観察中' : ended ? '観察完了' : !playing ? '一時停止' : flooded ? '増水中' : '観察中';
  $('play').innerHTML = icon(playing ? 'pause' : 'play'); $('play').setAttribute('aria-label', playing ? '一時停止' : ended ? 'はじめから再生' : '再生');
  $('live-label').parentElement!.classList.toggle('paused', !playing);
  range('timeline').max = String(history.length - 1); range('timeline').value = String(viewIndex);
  range('timeline').setAttribute('aria-valuetext', `${Math.floor(s.year)} 年`);
  $('timeline-end').textContent = `${Math.floor(model.state.year).toLocaleString('ja-JP')} 年`;
  $('timeline-start').textContent = `${Math.floor(history[0].year)} 年`;
  $('timeline-hint').textContent = ended ? '1,200 年の観察が完了しました' : targetYear !== null ? `${targetYear} 年まで早送り中` : '時間を戻して、川の記憶をたどる';
  $('latest').hidden = !past; $('history-hint').hidden = !past;
  for (const id of ['flow', 'erosion']) range(id).disabled = past || ended;
  $<HTMLButtonElement>('flood').disabled = past || ended || flooded;
  $('flood').innerHTML = `${icon('drop', 17)}<span>${flooded ? `増水中 · 残り ${Math.ceil(s.floodUntil - s.year)} 年` : '20 年間、増水させる'}</span><span>↗</span>`;
  $<HTMLButtonElement>('advance').disabled = ended;
  range('flow').value = String(s.flow); range('erosion').value = String(s.erodibility);
  $('flow-value').textContent = `${s.flow.toFixed(2)} ×`; $('erosion-value').textContent = `${s.erodibility.toFixed(2)} ×`;
  $('note').innerHTML = s.cutoffs > 0 ? '蛇行の首がつながり、流路が短くなりました。<br>取り残された曲がりが、川の記憶として残ります。' : sinuosity(s.points) > 1.6 ? '曲がりが大きくなり、川岸が近づいています。<br>つながったとき、川は新しい近道を選びます。' : '外側の岸が削れ、内側に砂がたまる。<br>小さな曲がりが、ゆっくり育っていきます。';
  const event = s.oxbows.at(-1);
  $('event').hidden = !event;
  const eventText = event ? `${Math.floor(event.born)} 年 — 流路が切り替わり、三日月湖が生まれました` : '';
  if ($('event').textContent !== eventText) $('event').textContent = eventText;
  for (const tool of ['raise', 'lower', 'restore']) $<HTMLButtonElement>(`tool-${tool}`).disabled = past || ended;
  for (const id of ['terrain-radius', 'terrain-strength']) $<HTMLSelectElement>(id).disabled = past || ended;
  $<HTMLButtonElement>('terrain-undo').disabled = past || ended || terrainUndo.length === 0 || strokeBefore !== null;
  $<HTMLButtonElement>('terrain-clear').disabled = past || ended || strokeBefore !== null;
  $('terrain-hint').textContent = past ? '過去の地形を表示しています。最新へ戻ると編集できます。' : terrainInput.tool ? '地形をなぞって編集。再生で川の変化を観察。矢印キー＋Enterでも操作できます。' : '盛る・削るで地形をなぞり、再生すると川の変化を観察できます。';
}
function reset(preset = PRESETS.find(p => p.id === $<HTMLSelectElement>('preset').value) ?? PRESETS[0]): void {
  stopEditing(); terrainUndo = [];
  seed = preset.seed; model = new RiverModel(seed, preset.flow, preset.erodibility);
  history = [model.snapshot()]; viewIndex = 0; replayYear = 0; accumulator = 0; lastCutoffs = 0; targetYear = null;
  playing = !reducedMotion; dirty = true; $('event').hidden = true;
  $('seed-label').textContent = String(seed).padStart(3, '0');
  $('field-title').innerHTML = `${preset.name} <span>— 自由に流れる氾濫原</span>`;
  $('preset-description').textContent = preset.description; sync();
}
function toggle(): void {
  stopEditing();
  if (model.state.year >= END_YEAR && !isHistory()) {
    if (history.length === 1) { reset(); playing = false; }
    else { viewIndex = 0; replayYear = history[0].year; }
  }
  playing = !playing; targetYear = null; accumulator = 0; dirty = true; sync();
}
$('play').addEventListener('click', toggle);
function stopEditing(): void {
  terrainInput.cancel(); terrainInput.setTool(null);
  for (const tool of ['observe', 'raise', 'lower', 'restore']) $(`tool-${tool}`).setAttribute('aria-pressed', String(tool === 'observe'));
}
for (const tool of ['observe', 'raise', 'lower', 'restore'] as const) {
  $(`tool-${tool}`).addEventListener('click', () => {
    playing = false; accumulator = 0; targetYear = null;
    terrainInput.setTool(tool === 'observe' ? null : tool as TerrainTool);
    for (const name of ['observe', 'raise', 'lower', 'restore']) $(`tool-${name}`).setAttribute('aria-pressed', String(name === tool));
    sync();
  });
}
$('terrain-radius').addEventListener('change', () => { terrainInput.radius = Number($<HTMLSelectElement>('terrain-radius').value); if (landscape.cursor) landscape.cursor.radius = terrainInput.radius; dirty = true; });
function replaceTerrain(field: TerrainField): void {
  playing = false; targetYear = null; accumulator = 0;
  history.push(model.snapshot()); model.state.terrain = field; history.push(model.snapshot()); viewIndex = history.length - 1; dirty = true; sync();
}
$('terrain-undo').addEventListener('click', () => { const field = terrainUndo.pop(); if (field) { replaceTerrain(field); notify('直前の地形編集を戻しました'); } });
$('terrain-clear').addEventListener('click', () => { terrainUndo.push(model.state.terrain); terrainUndo = terrainUndo.slice(-20); replaceTerrain(flatTerrain()); notify('川の形を保ち、地形を初期の高さへ戻しました'); });
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' || $<HTMLDialogElement>('about-dialog').open || (e.target as HTMLElement).closest('input,select,button,a,textarea')) return;
  e.preventDefault(); toggle();
});
$('preset').addEventListener('change', () => { reset(); notify('環境を変えて、新しい川の観察を始めました'); });
$('reset').addEventListener('click', () => { reset(); notify('初期の川に戻しました'); });
$('speed').addEventListener('change', () => { speed = Number($<HTMLSelectElement>('speed').value); accumulator = 0; });
for (const [id, key] of [['flow', 'flow'], ['erosion', 'erodibility']] as const) {
  $(id).addEventListener('input', () => { model.state[key] = Number(range(id).value); history[history.length - 1] = model.snapshot(); dirty = true; sync(); });
}
for (const [id, key] of [['trails', 'trails'], ['flow-layer', 'flow'], ['terrain', 'terrain']] as const) {
  $(id).addEventListener('change', () => { layers[key] = range(id).checked; dirty = true; });
}
$('flood').addEventListener('click', () => { model.flood(); history[history.length - 1] = model.snapshot(); dirty = true; sync(); notify('20 年間、川岸の移動が速くなります'); });
$('timeline').addEventListener('input', () => { stopEditing(); viewIndex = Number(range('timeline').value); replayYear = history[viewIndex].year; playing = false; targetYear = null; accumulator = 0; dirty = true; sync(); });
$('latest').addEventListener('click', () => { viewIndex = history.length - 1; accumulator = 0; dirty = true; sync(); });
$('advance').addEventListener('click', () => { stopEditing(); viewIndex = history.length - 1; targetYear = Math.min(END_YEAR, model.state.year + 100); playing = true; accumulator = 0; sync(); });
$('save').addEventListener('click', () => {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 2, seed, state: displayed() })); notify(`${Math.floor(displayed().year)} 年の川と地形を、このブラウザに保存しました`); }
  catch { notify('保存できませんでした。ブラウザの空き容量や設定を確認してください'); }
});
$('load').addEventListener('click', () => {
  try {
    const raw = localStorage.getItem(SAVE_KEY); if (!raw) { notify('保存した川はまだありません'); return; }
    const saved = decodeSave(raw); stopEditing(); terrainUndo = []; seed = saved.seed; model = new RiverModel(seed); model.state = saved.state;
    history = [model.snapshot()]; viewIndex = 0; replayYear = model.state.year; playing = false; targetYear = null; accumulator = 0; lastCutoffs = model.state.cutoffs;
    const preset = PRESETS.find(p => p.seed === seed) ?? PRESETS[0];
    $<HTMLSelectElement>('preset').value = preset.id; $('seed-label').textContent = String(seed).padStart(3, '0');
    $('field-title').innerHTML = `${preset.name} <span>— 保存した川</span>`; $('preset-description').textContent = preset.description;
    $('event').hidden = true; dirty = true; sync(); notify(`${Math.floor(model.state.year)} 年から観察を再開できます`);
  } catch { notify('保存データを読み込めませんでした。現在の川はそのまま観察できます'); }
});
$('capture').addEventListener('click', () => {
  const exportYear = Math.floor(displayed().year);
  landscape.draw(displayed(), history, layers, motion);
  landscape.canvas.toBlob(blob => {
    if (!blob) { notify('画像を保存できませんでした'); return; }
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `river-${exportYear}years.png`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000); notify('風景を PNG 画像にしました');
  });
});
let wasPlaying = false;
$('about').addEventListener('click', () => { wasPlaying = playing; playing = false; sync(); $<HTMLDialogElement>('about-dialog').showModal(); });
$('close-about').addEventListener('click', () => $<HTMLDialogElement>('about-dialog').close());
$('about-dialog').addEventListener('close', () => { playing = wasPlaying; accumulator = 0; last = performance.now(); sync(); });
document.addEventListener('visibilitychange', () => { terrainInput.cancel(); last = performance.now(); accumulator = 0; });
new ResizeObserver(() => { dirty = true; }).observe(landscape.canvas);

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  if (!document.hidden && playing) {
    if (!reducedMotion) motion += dt;
    if (isHistory()) {
      replayYear += dt * speed;
      while (viewIndex < history.length - 1 && history[viewIndex + 1].year <= replayYear) viewIndex++;
      dirty = true;
    } else {
      accumulator = Math.min(accumulator + dt * (targetYear !== null ? 200 : speed), 40);
      const started = performance.now();
      while (accumulator >= STEP && model.state.year < END_YEAR && performance.now() - started < 9) {
        model.step(); accumulator -= STEP;
        if (model.state.year % 2 === 0 || model.state.cutoffs !== lastCutoffs || model.state.year === END_YEAR) {
          history.push(model.snapshot()); viewIndex = history.length - 1;
        }
        if (model.state.cutoffs !== lastCutoffs) {
          lastCutoffs = model.state.cutoffs;
        }
        if (targetYear !== null && model.state.year >= targetYear) { targetYear = null; playing = false; accumulator = 0; break; }
      }
      if (model.state.year >= END_YEAR) playing = false;
      dirty = true;
    }
  }
  if (!document.hidden && dirty) { landscape.draw(displayed(), history, layers, motion); dirty = false; }
  if (now - lastUi > 100) { sync(); lastUi = now; }
  requestAnimationFrame(frame);
}
document.documentElement.setAttribute('data-booted', '');
sync(); requestAnimationFrame(frame);

import { chromium, devices } from 'playwright';

/**
 * ブラウザでの手触りを確認するスモークテスト。
 *
 *   npm run build && npm run preview          （別ターミナルで）
 *   node scripts/smoke.mjs [スクリーンショット出力先]
 *
 * 環境変数:
 *   BASE_URL     既定 http://127.0.0.1:4173/
 *   PW_CHROMIUM  Chromium の実行ファイルパス（省略時は Playwright 既定）
 *
 * 実際に「ステージ開始 → 水量スライダー操作 → 指で砂を削る → 視点切替 →
 * デバッグ表示 → 自由モード → 保存/初期化/読み込み」まで通し、
 * JS エラーが出ないことと収支表示を確認する。
 */
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const OUT = process.argv[2] || '.';


const errors = [];
const exePath = process.env.PW_CHROMIUM || undefined;
const browser = await chromium.launch(exePath ? { executablePath: exePath } : {});
const context = await browser.newContext({ ...devices['iPhone 13'], isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + '/shot-title.png' });

// タイトル → ステージ1
await page.getByRole('button', { name: /水をゴールへ届ける/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '/shot-stage1.png' });

// 水量スライダーを上げる
const slider = await page.locator('#water-slider .ws-track').boundingBox();
await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height * 0.15);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
const inflow1 = await page.evaluate(() => document.querySelector('#water-slider').getAttribute('aria-valuenow'));

// 砂を削る操作（指1本のドラッグ）
await page.locator('.tool[data-tool="lower"]').click();
const box = await page.locator('#board').boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.42);
await page.mouse.down();
for (let i = 0; i <= 20; i++) {
  await page.mouse.move(
    box.x + box.width * (0.5 - 0.28 * (i / 20)),
    box.y + box.height * (0.42 + 0.35 * (i / 20)),
  );
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + '/shot-dig.png' });

const state = await page.evaluate(() => {
  const txt = (s) => document.querySelector(s)?.textContent ?? '';
  return {
    sand: txt('#sand-bar'),
    meters: txt('#meters'),
    obj: txt('#objectives'),
    time: txt('#hud-time'),
  };
});

// 斜め視点
await page.getByRole('button', { name: '斜め視点' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + '/shot-oblique.png' });

// メニュー → デバッグ表示ON
await page.locator('#btn-menu').click();
await page.waitForTimeout(300);
await page.locator('#dbg-panel button:nth-child(2)').click();
await page.locator('#dbg-vel button:nth-child(2)').click();
await page.locator('[data-act="close"]').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT + '/shot-debug.png' });

const debugText = await page.evaluate(() => document.querySelector('.debug-panel')?.textContent ?? '');

// 自由モードへ
await page.locator('#btn-menu').click();
await page.waitForTimeout(200);
await page.locator('[data-act="title"]').click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /箱庭をはじめる/ }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT + '/shot-sandbox.png' });

// 保存 → 初期化 → 読み込み
await page.locator('#btn-menu').click();
await page.waitForTimeout(200);
await page.locator('[data-act="save"]').click();
await page.waitForTimeout(400);
const saved = await page.evaluate(() => !!localStorage.getItem('river.sandbox.save.v1'));
await page.locator('#btn-menu').click();
await page.waitForTimeout(200);
await page.locator('[data-act="reset"]').click();
await page.waitForTimeout(400);
await page.locator('#btn-menu').click();
await page.waitForTimeout(200);
const loadBtn = page.locator('[data-act="load"]');
const canLoad = await loadBtn.count();
if (canLoad) await loadBtn.click();
await page.waitForTimeout(800);

console.log(JSON.stringify({ inflow1, state, debugText: debugText.slice(0, 700), saved, canLoad, errors }, null, 1));
await browser.close();

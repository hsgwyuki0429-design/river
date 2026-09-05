import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const out = process.argv[2] || './tmp';
await mkdir(out, { recursive: true });
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const errors = [];
const url = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const saved = async page => {
  await page.locator('#save').click();
  return page.evaluate(() => JSON.parse(localStorage.getItem('river-observatory-v1')));
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  const base = await saved(page);
  assert.equal(base.version, 2);
  assert.ok(base.state.terrain.heights.every(h => h === 0));
  await page.locator('#tool-raise').click();
  const canvas = page.locator('#landscape');
  const mapPosition = async () => {
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox();
    return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.49 };
  };
  let { x, y } = await mapPosition();
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 100, y + 15, { steps: 20 }); await page.mouse.up();
  const hill = await saved(page);
  assert.ok(Math.max(...hill.state.terrain.heights) > 1);
  assert.equal(hill.state.year, 0);
  assert.deepEqual(hill.state.points, base.state.points, 'Editing does not teleport the channel');
  await page.locator('#timeline').fill('0');
  assert.equal(await page.locator('#tool-raise').isDisabled(), true);
  assert.deepEqual((await saved(page)).state.terrain, base.state.terrain, 'Past frames keep their own terrain');
  await page.locator('#latest').click();
  assert.deepEqual((await saved(page)).state.terrain, hill.state.terrain);
  await page.locator('#terrain-undo').click();
  assert.deepEqual((await saved(page)).state.terrain, base.state.terrain);

  // Reproduce hill and excavate a nearby corridor.
  await page.locator('#tool-raise').click(); ({ x, y } = await mapPosition()); await page.mouse.click(x, y - 20);
  await page.locator('#tool-lower').click();
  ({ x, y } = await mapPosition());
  await page.mouse.move(x - 70, y + 35); await page.mouse.down();
  await page.mouse.move(x + 140, y + 50, { steps: 20 }); await page.mouse.up();
  const edited = await saved(page);
  assert.ok(Math.min(...edited.state.terrain.heights) < -1);
  assert.ok(Math.max(...edited.state.terrain.heights) > 0);
  await page.locator('#notification').waitFor({ state: 'hidden' });
  await page.screenshot({ path: `${out}/terrain-before.png`, fullPage: true });
  // Save, clear, restore, then advance only the edited terrain scenario.
  await page.locator('#terrain-clear').click();
  await page.locator('#load').click();
  assert.deepEqual((await saved(page)).state.terrain, edited.state.terrain);
  await page.locator('#advance').click();
  await page.waitForFunction(() => document.querySelector('#year').textContent === '100');
  const evolved = await saved(page);
  assert.deepEqual(evolved.state.terrain, edited.state.terrain);
  assert.notDeepEqual(evolved.state.points, edited.state.points);
  await page.locator('#notification').waitFor({ state: 'hidden' });
  await page.screenshot({ path: `${out}/terrain-after.png`, fullPage: true });
  await page.locator('#reset').click();
  await page.locator('#advance').click();
  await page.waitForFunction(() => document.querySelector('#year').textContent === '100');
  const control = await saved(page);
  assert.notDeepEqual(evolved.state.points, control.state.points, 'Terrain edits change subsequent river evolution');

  // Cancelling a partial stroke restores its original terrain.
  await page.locator('#reset').click(); await page.locator('#tool-raise').click();
  ({ x, y } = await mapPosition());
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 90, y, { steps: 10 });
  await canvas.press('Escape'); await page.mouse.up();
  assert.ok((await saved(page)).state.terrain.heights.every(h => h === 0));
  await canvas.focus(); await canvas.press('ArrowRight'); await canvas.press('Enter');
  const keyboardHill = await saved(page);
  assert.ok(Math.max(...keyboardHill.state.terrain.heights) > 0, 'Keyboard editing works');
  await page.locator('#tool-restore').click(); await canvas.press('Enter');
  assert.ok((await saved(page)).state.terrain.heights.reduce((a, b) => a + Math.abs(b), 0) < keyboardHill.state.terrain.heights.reduce((a, b) => a + Math.abs(b), 0), 'Restore brush reduces the edit');
  const mobile = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
  const phone = await mobile.newPage(); phone.on('pageerror', e => errors.push(e.message));
  await phone.goto(url, { waitUntil: 'networkidle' });
  await phone.locator('#tool-raise').click(); await phone.locator('#terrain-radius').selectOption('80');
  await phone.locator('#landscape').scrollIntoViewIfNeeded();
  const mobileRect = await phone.locator('#landscape').boundingBox();
  // Actual touch events exercise pointer capture on the rotated portrait map.
  const session = await mobile.newCDPSession(phone);
  const tx = mobileRect.x + mobileRect.width * 0.55, ty = mobileRect.y + mobileRect.height * 0.5;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  for (let i = 1; i <= 8; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx + i * 3, y: ty + i * 5 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const phoneSave = await saved(phone);
  assert.ok(Math.max(...phoneSave.state.terrain.heights) > 0);
  const total = phoneSave.state.terrain.heights.reduce((a, b) => a + b, 0);
  const meanY = phoneSave.state.terrain.heights.reduce((a, b, i) => a + b * (-3200 + Math.floor(i / 121) * 40), 0) / total;
  assert.ok(meanY < 0, 'The portrait map correctly maps rightward touch to negative world Y');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.locator('#notification').waitFor({ state: 'hidden' });
  await phone.screenshot({ path: `${out}/terrain-mobile.png`, fullPage: true });
  await phone.setViewportSize({ width: 320, height: 700 });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, tested: ['drag raise/lower', 'immutable past terrain', 'undo', 'clear/load', 'terrain-dependent evolution', 'cancel stroke', 'keyboard', 'portrait touch', '320px overflow'], errors }, null, 2));
} finally { await browser.close(); }

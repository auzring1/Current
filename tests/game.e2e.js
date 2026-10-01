'use strict';
// Headless browser test: plays the real game with an autopilot and checks invariants.
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const assert = require('assert');
const shots = process.env.SHOTS_DIR;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  if (shots) await page.screenshot({ path: shots + '/title.png' });

  const result = await page.evaluate(() => {
    const G = window.BrickGame, g = G.g;
    const out = { levelsCleared: 0, maxBalls: 1, powerups: {}, violations: [], lifeLost: 0, speeds: [] };
    G.startGame();
    const origApply = G.applyPowerup;
    let frames = 0, lastLives = g.lives;
    // Autopilot: track the lowest descending ball (with a little imperfection so lives can be lost).
    while (frames < 120 * 60 * 20 && g.state !== 'gameover' && out.levelsCleared < 3) {
      if (g.state === 'ready') { G.action(); }
      if (g.state === 'levelclear') {
        out.levelsCleared++; out.speeds.push(G.levelSpeed(g.level));
        if (out.levelsCleared >= 3) break;
        G.action(); continue;
      }
      const balls = g.balls.filter(b => !b.stuck);
      if (balls.length) {
        const b = balls.reduce((a, c) => (c.y > a.y ? c : a));
        const wobble = Math.sin(frames / 300) * g.paddle.w * 0.35;
        g.targetX = b.x + wobble;
      }
      G.update(G.STEP); frames++;
      // invariants
      for (const b of g.balls) {
        if (b.stuck) continue;
        if (b.x < 0 || b.x > G.W || b.y < 0) out.violations.push('ball out of bounds ' + b.x + ',' + b.y);
        const sp = Math.hypot(b.vx, b.vy);
        if (Math.abs(sp - b.speed) > 0.5) out.violations.push('speed drift ' + sp + ' vs ' + b.speed);
        if (!isFinite(b.x) || !isFinite(b.y)) out.violations.push('NaN');
      }
      out.maxBalls = Math.max(out.maxBalls, g.balls.length);
      if (g.lives < lastLives) out.lifeLost++;
      lastLives = g.lives;
    }
    out.frames = frames; out.state = g.state; out.score = g.score; out.lives = g.lives; out.level = g.level;
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepStrictEqual(result.violations.slice(0, 3), [], 'invariant violations');
  assert(result.levelsCleared >= 3, 'autopilot should clear 3 levels, got ' + result.levelsCleared);
  assert(result.speeds[0] < result.speeds[1] && result.speeds[1] < result.speeds[2], 'speed must rise per level');
  assert(result.score > 0);

  // Direct feature checks: power-ups, lives, game over
  const feat = await page.evaluate(() => {
    const G = window.BrickGame, g = G.g, r = {};
    G.startGame(); G.action(); // launch
    for (let i = 0; i < 60; i++) G.update(G.STEP);
    const n0 = g.balls.length; G.applyPowerup('multi'); r.multi = [n0, g.balls.length];
    G.applyPowerup('expand'); for (let i = 0; i < 120; i++) G.update(G.STEP); r.wide = g.paddle.w;
    G.applyPowerup('slow'); r.slow = g.balls[0].speed < G.levelSpeed(1) * 0.8;
    const l0 = g.lives; G.applyPowerup('life'); r.life = [l0, g.lives];
    // lose all lives
    g.targetX = 0; g.paddle.x = 0;
    for (let k = 0; k < 4 && g.state !== 'gameover'; k++) {
      if (g.state === 'ready') G.action();
      g.balls.forEach(b => { b.x = 700; b.y = 560; b.vx = 0; b.vy = 300; });
      g.targetX = 0;
      for (let i = 0; i < 400 && g.balls.length; i++) G.update(G.STEP);
    }
    r.finalState = g.state; r.finalLives = g.lives;
    return r;
  });
  console.log(JSON.stringify(feat));
  assert.strictEqual(feat.multi[1] > feat.multi[0], true, 'multiball adds balls');
  assert(feat.wide > 150, 'paddle widened');
  assert(feat.slow, 'slow reduces speed');
  assert.strictEqual(feat.life[1], feat.life[0] + 1);
  assert.strictEqual(feat.finalState, 'gameover');
  assert.strictEqual(feat.finalLives, 0);

  // Real input path + screenshots (mouse, keyboard) at desktop and phone sizes
  await page.evaluate(() => window.BrickGame.startGame());
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.8);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(1200);
  assert.strictEqual(await page.evaluate(() => window.BrickGame.g.state), 'playing');
  if (shots) await page.screenshot({ path: shots + '/play.png' });
  await page.keyboard.press('p');
  assert.strictEqual(await page.evaluate(() => window.BrickGame.g.state), 'paused');
  await page.keyboard.press('p');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(300);
  const mb = await page.locator('canvas').boundingBox();
  assert(mb.width <= 390 && mb.x >= 0, 'canvas fits phone width: ' + JSON.stringify(mb));
  if (shots) await page.screenshot({ path: shots + '/mobile.png' });

  assert.deepStrictEqual(errors, [], 'console errors');
  await browser.close();
  console.log('e2e passed');
})().catch(e => { console.error(e); process.exit(1); });

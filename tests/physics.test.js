'use strict';
const assert = require('assert');
const P = require('../physics.js');
const world = { w: 800, h: 600 };
const noHooks = {};
let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }
const mk = (x, y, vx, vy) => ({ x, y, vx, vy, r: 7, speed: Math.hypot(vx, vy) });
const paddle = { x: 345, y: 550, w: 110, h: 14 };

test('wall bounces keep ball inside and preserve speed', () => {
  const b = mk(400, 300, 300, -200); const s0 = b.speed;
  for (let i = 0; i < 20000; i++) {
    P.stepBall(b, 1 / 120, world, [], { x: 0, y: 550, w: 800, h: 14 }, noHooks);
    assert(b.x >= b.r - 1e-6 && b.x <= world.w - b.r + 1e-6 && b.y >= b.r - 1e-6, 'out of bounds');
    assert(Math.abs(Math.hypot(b.vx, b.vy) - s0) < 1e-6, 'speed drift');
  }
});

test('paddle reflects upward; angle depends on hit offset', () => {
  const centre = mk(400, 540, 0, 400); P.stepBall(centre, 1 / 60, world, [], paddle, noHooks);
  assert(centre.vy < 0 && Math.abs(centre.vx) < 1e-6);
  const right = mk(445, 540, 0, 400); P.stepBall(right, 1 / 60, world, [], paddle, noHooks);
  assert(right.vy < 0 && right.vx > 100);
  const left = mk(355, 540, 0, 400); P.stepBall(left, 1 / 60, world, [], paddle, noHooks);
  assert(left.vx < -100);
  assert(Math.abs(Math.hypot(right.vx, right.vy) - 400) < 1e-6);
});

test('brick hit from below flips vy, from side flips vx', () => {
  const brick = () => [{ x: 100, y: 100, w: 58, h: 22, alive: true }];
  const up = mk(130, 131, 50, -300); P.stepBall(up, 1 / 60, world, brick(), null, noHooks);
  assert(up.vy > 0, 'vertical flip');
  const side = mk(91, 111, 300, -120); const hits = [];
  P.stepBall(side, 1 / 60, world, brick(), null, { brick: b => hits.push(b) });
  assert(side.vx < 0 && hits.length === 1, 'horizontal flip');
});

test('no tunnelling at very high speed (1500px/s, thin bricks, big dt)', () => {
  for (let k = 0; k < 500; k++) {
    const bricks = [{ x: 0, y: 200, w: 800, h: 4, alive: true }];
    const b = mk(100 + k, 240, 200 * Math.sin(k), -1500); b.speed = Math.hypot(b.vx, b.vy);
    let hit = false;
    P.stepBall(b, 0.05, world, bricks, null, { brick: () => { hit = true; } });
    assert(hit && b.vy > 0, 'tunnelled at k=' + k);
  }
});

test('ball cannot get stuck in a near-horizontal rally', () => {
  const b = mk(400, 300, 400, -2); b.speed = Math.hypot(b.vx, b.vy);
  P.stepBall(b, 1 / 60, world, [], paddle, noHooks); // not yet at wall
  for (let i = 0; i < 400; i++) P.stepBall(b, 1 / 120, world, [], { x: 0, y: 550, w: 800, h: 14 }, noHooks);
  assert(Math.abs(b.vy) / b.speed >= P.MIN_VERTICAL_RATIO - 1e-6);
});

test('ball reported lost below the screen', () => {
  const b = mk(10, 590, 0, 300);
  let alive = true;
  for (let i = 0; i < 120 && alive; i++) alive = P.stepBall(b, 1 / 120, world, [], paddle, noHooks);
  assert(alive === false);
});

test('one brick hit per contact (no double-counting on a corner)', () => {
  const bricks = [{ x: 100, y: 100, w: 58, h: 22, alive: true }];
  const b = mk(94, 94, 150, 150); let hits = 0;
  for (let i = 0; i < 20; i++) P.stepBall(b, 1 / 120, world, bricks, null, { brick: () => hits++ });
  assert(hits === 1, 'hits=' + hits);
});

console.log(`\n${n} physics tests passed`);

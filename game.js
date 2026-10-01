/* Retro Brick Breaker - game logic, input and rendering. */
(function () {
  'use strict';
  const P = window.Physics;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const HUD_H = 40;

  const BASE_SPEED = 340;       // px/s on level 1
  const SPEED_PER_LEVEL = 0.12; // +12% each level
  const MAX_SPEED = 760;
  const PADDLE_W = 110, PADDLE_WIDE = 175, PADDLE_H = 14, PADDLE_Y = H - 50;
  const BALL_R = 7;
  const MAX_BALLS = 6;
  const STEP = 1 / 120;         // fixed physics timestep

  // Level layouts: digit = brick hit points, '.' = empty. 12 columns.
  const LAYOUTS = [
    ['............', '.1111111111.', '.1111111111.', '.1111111111.', '.1111111111.'],
    ['111111111111', '1.1.1.1.1.1.', '.2.2.2.2.2.2', '111111111111', '.1.1.1.1.1.1'],
    ['.....11.....', '....2112....', '...211112...', '..21111112..', '.2111111112.', '211111111112'],
    ['222222222222', '111111111111', '2.2.2.2.2.2.', '111111111111', '222222222222'],
    ['3.3.3.3.3.3.', '.2222222222.', '3.1.1.1.1.13', '.2222222222.', '3.3.3.3.3.3.', '111111111111'],
  ];
  const ROW_COLORS = ['#ff3c6e', '#ff8a3c', '#ffd23c', '#7dff3c', '#3ef0ff', '#a05cff'];
  const POWERUPS = {
    expand: { label: 'E', color: '#3ef0ff', weight: 35 },
    multi:  { label: 'M', color: '#ff3cac', weight: 30 },
    slow:   { label: 'S', color: '#ffd23c', weight: 22 },
    life:   { label: '♥', color: '#ff4040', weight: 6 },
  };

  const g = {
    state: 'title', // title | ready | playing | paused | levelclear | gameover
    score: 0, high: 0, lives: 3, level: 1,
    bricks: [], balls: [], drops: [], particles: [],
    paddle: { x: (W - PADDLE_W) / 2, y: PADDLE_Y, w: PADDLE_W, h: PADDLE_H },
    targetX: W / 2, wideT: 0, slowT: 0, shake: 0, time: 0,
    keys: { left: false, right: false },
    muted: false, rng: Math.random,
  };
  try { g.high = +localStorage.getItem('brickbreaker.high') || 0; } catch (e) { /* ignore */ }

  // ---------- audio (tiny WebAudio beeps) ----------
  let actx = null;
  function beep(freq, dur, type, vol) {
    if (g.muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), v = actx.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      v.gain.value = vol || 0.04;
      v.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(v); v.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + dur);
    } catch (e) { /* audio unavailable */ }
  }

  // ---------- level setup ----------
  function levelSpeed(level) {
    return Math.min(MAX_SPEED, BASE_SPEED * (1 + SPEED_PER_LEVEL * (level - 1)));
  }
  function currentSpeed() { return levelSpeed(g.level) * (g.slowT > 0 ? 0.7 : 1); }

  function buildLevel(level) {
    const layout = LAYOUTS[(level - 1) % LAYOUTS.length];
    const bonus = Math.floor((level - 1) / LAYOUTS.length); // extra HP on later cycles
    const cols = 12, gap = 4, side = 30;
    const bw = (W - side * 2 - gap * (cols - 1)) / cols, bh = 22;
    const bricks = [];
    layout.forEach((row, r) => {
      for (let c = 0; c < cols; c++) {
        const ch = row[c];
        if (!ch || ch === '.') continue;
        const hp = Math.min(4, +ch + bonus);
        const type = g.rng() < 0.22 ? pickPowerup() : null;
        bricks.push({ x: side + c * (bw + gap), y: HUD_H + 36 + r * (bh + gap), w: bw, h: bh,
          hp, maxHp: hp, row: r, alive: true, drop: type, points: 10 * hp });
      }
    });
    return bricks;
  }
  function pickPowerup() {
    const keys = Object.keys(POWERUPS);
    let total = 0; keys.forEach(k => (total += POWERUPS[k].weight));
    let n = g.rng() * total;
    for (const k of keys) { n -= POWERUPS[k].weight; if (n <= 0) return k; }
    return keys[0];
  }

  function newBall(x, y, vx, vy) { return { x, y, vx, vy, r: BALL_R, speed: currentSpeed(), stuck: false, trail: [] }; }
  function resetBallOnPaddle() {
    g.balls = [newBall(g.paddle.x + g.paddle.w / 2, g.paddle.y - BALL_R - 1, 0, 0)];
    g.balls[0].stuck = true;
    g.state = 'ready';
  }
  function startGame() {
    g.score = 0; g.lives = 3; g.level = 1;
    startLevel();
  }
  function startLevel() {
    g.bricks = buildLevel(g.level);
    g.drops = []; g.wideT = 0; g.slowT = 0;
    g.paddle.w = PADDLE_W;
    resetBallOnPaddle();
  }
  function launch() {
    if (g.state !== 'ready') return;
    const b = g.balls[0];
    const a = (g.rng() * 0.5 - 0.25); // slight random angle off vertical
    b.speed = currentSpeed();
    b.vx = b.speed * Math.sin(a); b.vy = -b.speed * Math.cos(a);
    b.stuck = false; g.state = 'playing'; beep(440, 0.08);
  }

  // ---------- effects ----------
  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = g.rng() * Math.PI * 2, s = 40 + g.rng() * 160;
      g.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + g.rng() * 0.4, color });
    }
  }
  function applyPowerup(type) {
    beep(880, 0.15, 'triangle', 0.06);
    if (type === 'expand') { g.wideT = 15; }
    else if (type === 'slow') { g.slowT = 8; rescaleBalls(); }
    else if (type === 'life') { g.lives = Math.min(5, g.lives + 1); }
    else if (type === 'multi') {
      const src = g.balls.filter(b => !b.stuck);
      const added = [];
      for (const b of src) {
        for (const da of [-0.4, 0.4]) {
          if (g.balls.length + added.length >= MAX_BALLS) break;
          const c = Math.cos(da), s = Math.sin(da);
          added.push(newBall(b.x, b.y, b.vx * c - b.vy * s, b.vx * s + b.vy * c));
        }
      }
      added.forEach(b => { P.setSpeed(b, currentSpeed()); b.speed = currentSpeed(); P.sanitizeVelocity(b); });
      g.balls.push(...added);
    }
  }
  function rescaleBalls() {
    const s = currentSpeed();
    g.balls.forEach(b => { b.speed = s; if (!b.stuck) P.setSpeed(b, s); });
  }
  function setPaddleWidth(w) {
    const cx = g.paddle.x + g.paddle.w / 2;
    g.paddle.w = w; g.paddle.x = clampPaddle(cx - w / 2);
  }
  function clampPaddle(x) { return Math.max(0, Math.min(W - g.paddle.w, x)); }

  // ---------- update ----------
  const hooks = {
    wall() { beep(220, 0.04); },
    paddle() { beep(330, 0.05); },
    brick(b) {
      b.hp--;
      if (b.hp > 0) { beep(280, 0.05); burst(b.x + b.w / 2, b.y + b.h / 2, '#fff', 3); return; }
      b.alive = false;
      const mult = 1 + (g.level - 1) * 0.25;
      g.score += Math.round(b.points * mult);
      if (g.score > g.high) g.high = g.score;
      burst(b.x + b.w / 2, b.y + b.h / 2, ROW_COLORS[b.row % ROW_COLORS.length], 12);
      if (b.drop) g.drops.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, type: b.drop, vy: 130 });
      g.shake = 0.12; beep(520 + b.row * 40, 0.07);
    },
  };

  function update(dt) {
    g.time += dt;
    const p = g.paddle;
    // paddle control
    const kdir = (g.keys.right ? 1 : 0) - (g.keys.left ? 1 : 0);
    if (kdir) { g.targetX = clampPaddle(p.x + p.w / 2 + kdir * 640 * dt) + p.w / 2; }
    const tx = clampPaddle(g.targetX - p.w / 2);
    p.x += (tx - p.x) * Math.min(1, dt * 28);
    p.x = clampPaddle(p.x);

    g.particles = g.particles.filter(q => { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 300 * dt; return q.life > 0; });
    g.shake = Math.max(0, g.shake - dt);

    if (g.state === 'ready') { const b = g.balls[0]; b.x = p.x + p.w / 2; b.y = p.y - b.r - 1; }
    if (g.state !== 'playing' && g.state !== 'ready') return;

    // timers
    if (g.wideT > 0) {
      g.wideT -= dt;
      const target = g.wideT > 0 ? PADDLE_WIDE : PADDLE_W;
      if (p.w !== target) setPaddleWidth(p.w + Math.sign(target - p.w) * Math.min(Math.abs(target - p.w), 400 * dt));
    } else if (p.w !== PADDLE_W) setPaddleWidth(p.w - Math.min(p.w - PADDLE_W, 400 * dt));
    if (g.slowT > 0) { g.slowT -= dt; if (g.slowT <= 0) rescaleBalls(); }
    if (g.state !== 'playing') return;

    // balls
    const world = { w: W, h: H };
    g.balls = g.balls.filter(b => {
      b.trail.push({ x: b.x, y: b.y }); if (b.trail.length > 8) b.trail.shift();
      return P.stepBall(b, dt, world, g.bricks, p, hooks);
    });

    // falling power-ups
    g.drops = g.drops.filter(d => {
      d.y += d.vy * dt;
      if (d.y > p.y - 10 && d.y < p.y + p.h + 10 && d.x > p.x - 10 && d.x < p.x + p.w + 10) { applyPowerup(d.type); return false; }
      return d.y < H + 20;
    });

    if (g.balls.length === 0) {
      g.lives--; g.drops = []; g.wideT = 0; g.slowT = 0; g.shake = 0.3; beep(110, 0.4, 'sawtooth', 0.06);
      p.w = PADDLE_W;
      if (g.lives <= 0) { g.state = 'gameover'; saveHigh(); } else resetBallOnPaddle();
    } else if (!g.bricks.some(b => b.alive)) {
      g.state = 'levelclear'; g.score += 100 * g.level; if (g.score > g.high) g.high = g.score;
      g.drops = []; saveHigh(); beep(660, 0.3, 'triangle', 0.06);
    }
  }
  function saveHigh() { try { localStorage.setItem('brickbreaker.high', String(g.high)); } catch (e) { /* ignore */ } }

  let acc = 0, last = 0;
  function frame(ts) {
    const dt = Math.min(0.05, (ts - last) / 1000 || 0); last = ts;
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    render();
    requestAnimationFrame(frame);
  }

  // ---------- rendering ----------
  function text(s, x, y, size, color, align) {
    ctx.font = 'bold ' + size + 'px "Courier New", monospace';
    ctx.textAlign = align || 'center'; ctx.fillStyle = color || '#fff'; ctx.fillText(s, x, y);
  }
  function glowRect(x, y, w, h, color) {
    ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x, y + h - 3, w, 3);
  }
  function render() {
    ctx.save();
    ctx.fillStyle = '#0b0720'; ctx.fillRect(0, 0, W, H);
    // starry grid
    ctx.strokeStyle = 'rgba(120,80,255,.08)'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, HUD_H); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = HUD_H; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (g.shake > 0) ctx.translate((g.rng() - 0.5) * 6, (g.rng() - 0.5) * 6);

    for (const b of g.bricks) {
      if (!b.alive) continue;
      const base = ROW_COLORS[b.row % ROW_COLORS.length];
      glowRect(b.x, b.y, b.w, b.h, base);
      if (b.maxHp > 1) { // tougher bricks get darker overlay that lightens as damaged
        ctx.fillStyle = 'rgba(0,0,0,' + (0.15 * b.hp) + ')'; ctx.fillRect(b.x, b.y + 3, b.w, b.h - 6);
        text(String(b.hp), b.x + b.w / 2, b.y + b.h - 6, 14, '#fff');
      }
      if (b.drop) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2); }
    }

    for (const d of g.drops) {
      const pu = POWERUPS[d.type];
      ctx.fillStyle = pu.color; ctx.shadowColor = pu.color; ctx.shadowBlur = 12;
      ctx.fillRect(d.x - 12, d.y - 10, 24, 20); ctx.shadowBlur = 0;
      text(pu.label, d.x, d.y + 6, 16, '#000');
    }

    // paddle
    const p = g.paddle;
    ctx.shadowColor = '#3ef0ff'; ctx.shadowBlur = 14;
    glowRect(p.x, p.y, p.w, p.h, g.wideT > 0 ? '#3ef0ff' : '#d8f6ff'); ctx.shadowBlur = 0;

    // balls
    for (const b of g.balls) {
      b.trail.forEach((t, i) => { ctx.fillStyle = 'rgba(255,255,255,' + (i / b.trail.length * 0.25) + ')'; ctx.fillRect(t.x - 3, t.y - 3, 6, 6); });
      ctx.shadowColor = '#fff'; ctx.shadowBlur = 12; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    for (const q of g.particles) { ctx.globalAlpha = Math.max(0, q.life * 1.6); ctx.fillStyle = q.color; ctx.fillRect(q.x - 2, q.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
    ctx.restore();

    // HUD
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, W, HUD_H);
    ctx.fillStyle = '#3ef0ff'; ctx.fillRect(0, HUD_H - 2, W, 2);
    text('SCORE ' + String(g.score).padStart(6, '0'), 12, 27, 20, '#ffd23c', 'left');
    text('HI ' + String(g.high).padStart(6, '0'), W / 2 - 60, 27, 16, '#a05cff');
    text('LV ' + g.level + ' ×' + (levelSpeed(g.level) / BASE_SPEED).toFixed(1), W / 2 + 90, 27, 16, '#7dff3c');
    for (let i = 0; i < g.lives; i++) {
      ctx.fillStyle = '#ff3c6e'; ctx.fillRect(W - 24 - i * 26, 12, 18, 14); ctx.fillStyle = '#fff'; ctx.fillRect(W - 24 - i * 26, 12, 18, 3);
    }
    // active power-up timers
    let ty = HUD_H + 18;
    if (g.wideT > 0) { text('WIDE ' + g.wideT.toFixed(0) + 's', W - 10, ty, 13, '#3ef0ff', 'right'); ty += 16; }
    if (g.slowT > 0) text('SLOW ' + g.slowT.toFixed(0) + 's', W - 10, ty, 13, '#ffd23c', 'right');

    // overlays
    if (g.state === 'title') overlay('BRICK BREAKER', 'CLICK / TAP / SPACE TO START', 'Catch falling letters: E=wide  M=multi-ball  S=slow  ♥=life');
    else if (g.state === 'ready') text(g.level === 1 && g.score === 0 ? 'CLICK / TAP / SPACE TO LAUNCH' : 'READY - LEVEL ' + g.level, W / 2, H / 2 + 60, 20, '#fff');
    else if (g.state === 'paused') overlay('PAUSED', 'PRESS P OR TAP TO RESUME');
    else if (g.state === 'levelclear') overlay('LEVEL ' + g.level + ' CLEAR!', 'BONUS +' + 100 * g.level + ' — TAP / SPACE FOR NEXT LEVEL', 'Next level is ' + Math.round((levelSpeed(g.level + 1) / levelSpeed(g.level) - 1) * 100) + '% faster');
    else if (g.state === 'gameover') overlay('GAME OVER', 'SCORE ' + g.score + ' — TAP / SPACE TO RETRY', g.score >= g.high && g.score > 0 ? 'NEW HIGH SCORE!' : '');
  }
  function overlay(title, sub, small) {
    ctx.fillStyle = 'rgba(5,2,20,.72)'; ctx.fillRect(0, HUD_H, W, H - HUD_H);
    ctx.shadowColor = '#ff3cac'; ctx.shadowBlur = 20;
    text(title, W / 2, H / 2 - 20, 54, '#ff3cac'); ctx.shadowBlur = 0;
    text(sub, W / 2, H / 2 + 28, 20, '#3ef0ff');
    if (small) text(small, W / 2, H / 2 + 62, 15, '#ffd23c');
  }

  // ---------- input ----------
  function action() {
    if (g.state === 'title' || g.state === 'gameover') startGame();
    else if (g.state === 'ready') launch();
    else if (g.state === 'levelclear') { g.level++; startLevel(); }
    else if (g.state === 'paused') g.state = g.balls.some(b => b.stuck) ? 'ready' : 'playing';
  }
  function togglePause() {
    if (g.state === 'playing' || g.state === 'ready') { g.pausedFrom = g.state; g.state = 'paused'; }
    else if (g.state === 'paused') g.state = g.pausedFrom || 'playing';
  }
  function pointerX(clientX) {
    const r = canvas.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * W;
  }
  canvas.addEventListener('mousemove', e => { g.targetX = pointerX(e.clientX); });
  canvas.addEventListener('mousedown', e => { g.targetX = pointerX(e.clientX); action(); });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); g.targetX = pointerX(e.touches[0].clientX); action(); }, { passive: false });
  canvas.addEventListener('touchmove', e => { e.preventDefault(); g.targetX = pointerX(e.touches[0].clientX); }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') g.keys.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') g.keys.right = true;
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) action(); }
    else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause();
    else if (e.key === 'm' || e.key === 'M') g.muted = !g.muted;
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') g.keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') g.keys.right = false;
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && g.state === 'playing') togglePause(); });

  // Exposed for tests / debugging.
  window.BrickGame = { g, update, action, startGame, startLevel, launch, applyPowerup, levelSpeed, STEP, W, H };
  render();
  requestAnimationFrame(frame);
})();

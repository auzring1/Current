/* Retro Brick Breaker - pure physics (no DOM), usable in browser and Node. */
(function (root) {
  'use strict';

  const MAX_PADDLE_ANGLE = (60 * Math.PI) / 180; // from vertical
  const MIN_VERTICAL_RATIO = 0.22; // avoids near-horizontal "stuck" rallies

  /** Closest-point circle vs AABB test. Returns {nx, ny, pen} or null. */
  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const px = Math.max(rx, Math.min(cx, rx + rw));
    const py = Math.max(ry, Math.min(cy, ry + rh));
    let dx = cx - px;
    let dy = cy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) return null;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      return { nx: dx / d, ny: dy / d, pen: r - d };
    }
    // Centre is inside the rect: push out through the nearest edge.
    const l = cx - rx, rr = rx + rw - cx, t = cy - ry, b = ry + rh - cy;
    const m = Math.min(l, rr, t, b);
    if (m === t) return { nx: 0, ny: -1, pen: r + t };
    if (m === b) return { nx: 0, ny: 1, pen: r + b };
    if (m === l) return { nx: -1, ny: 0, pen: r + l };
    return { nx: 1, ny: 0, pen: r + rr };
  }

  /** Set velocity magnitude to `speed`, keeping direction. */
  function setSpeed(ball, speed) {
    const cur = Math.hypot(ball.vx, ball.vy) || 1;
    ball.vx = (ball.vx / cur) * speed;
    ball.vy = (ball.vy / cur) * speed;
  }

  /** Keep the ball from travelling almost horizontally, then fix speed. */
  function sanitizeVelocity(ball) {
    const s = ball.speed;
    const minVy = s * MIN_VERTICAL_RATIO;
    if (Math.abs(ball.vy) < minVy) {
      ball.vy = (ball.vy < 0 || ball.vy === 0 ? -1 : 1) * minVy;
      const vx = Math.sqrt(Math.max(0, s * s - ball.vy * ball.vy));
      ball.vx = (ball.vx < 0 ? -1 : 1) * vx;
    }
    setSpeed(ball, s);
  }

  function paddleBounce(ball, paddle) {
    const t = Math.max(-1, Math.min(1, (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2)));
    const a = t * MAX_PADDLE_ANGLE;
    ball.vx = ball.speed * Math.sin(a);
    ball.vy = -ball.speed * Math.cos(a);
    ball.y = paddle.y - ball.r - 0.01;
  }

  /**
   * Advance one ball by dt seconds. Sub-steps so a fast ball can never move
   * more than half its radius per step (no tunnelling through bricks).
   * hooks: { wall(), paddle(), brick(brick) -> void (may set brick.alive=false), lost() }
   * Returns false when the ball fell out of the bottom.
   */
  function stepBall(ball, dt, world, bricks, paddle, hooks) {
    const speed = Math.hypot(ball.vx, ball.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / (ball.r * 0.5)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;

      // Walls
      let bounced = false;
      if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); bounced = true; }
      else if (ball.x > world.w - ball.r) { ball.x = world.w - ball.r; ball.vx = -Math.abs(ball.vx); bounced = true; }
      if (ball.y < ball.r) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); bounced = true; }
      if (bounced) { sanitizeVelocity(ball); hooks.wall && hooks.wall(ball); }

      // Paddle (only when descending and the ball is above the paddle's middle)
      if (ball.vy > 0 && paddle) {
        const c = circleRect(ball.x, ball.y, ball.r, paddle.x, paddle.y, paddle.w, paddle.h);
        if (c && ball.y < paddle.y + paddle.h * 0.5) {
          paddleBounce(ball, paddle);
          hooks.paddle && hooks.paddle(ball);
        }
      }

      // Bricks: resolve only the deepest overlap per sub-step.
      let best = null, bestBrick = null;
      for (let k = 0; k < bricks.length; k++) {
        const b = bricks[k];
        if (!b.alive) continue;
        const c = circleRect(ball.x, ball.y, ball.r, b.x, b.y, b.w, b.h);
        if (c && (!best || c.pen > best.pen)) { best = c; bestBrick = b; }
      }
      if (best) {
        ball.x += best.nx * best.pen;
        ball.y += best.ny * best.pen;
        const dot = ball.vx * best.nx + ball.vy * best.ny;
        if (dot < 0) {
          ball.vx -= 2 * dot * best.nx;
          ball.vy -= 2 * dot * best.ny;
        }
        sanitizeVelocity(ball);
        hooks.brick && hooks.brick(bestBrick, ball);
      }

      if (ball.y - ball.r > world.h) return false;
    }
    return true;
  }

  const api = { circleRect, stepBall, setSpeed, sanitizeVelocity, paddleBounce, MAX_PADDLE_ANGLE, MIN_VERTICAL_RATIO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Physics = api;
})(typeof window !== 'undefined' ? window : globalThis);

import {
  AIM_SETTLED,
  INPUT_AIM,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_THRUST,
  SHIP_DAMPING,
  SHIP_MAX_SPEED,
  SHIP_THRUST,
  SHIP_TURN_RATE,
  WORLD_H,
  WORLD_W,
} from "./constants";

const TAU = Math.PI * 2;

export type Kinematic = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ang: number;
};

/**
 * The one copy of ship movement. The leader runs it at 30 Hz and every browser
 * runs it against its own ship at frame rate — if these ever drift apart, local
 * prediction starts fighting the server and the ship stutters.
 */
export function stepKinematics(
  body: Kinematic,
  input: number,
  aim: number,
  dt: number,
): void {
  body.ang = steer(body.ang, input, aim, dt);

  if (input & INPUT_THRUST) {
    body.vx += Math.cos(body.ang) * SHIP_THRUST * dt;
    body.vy += Math.sin(body.ang) * SHIP_THRUST * dt;
  }

  const damping = Math.exp(-SHIP_DAMPING * dt);
  body.vx *= damping;
  body.vy *= damping;

  const speed = Math.hypot(body.vx, body.vy);
  if (speed > SHIP_MAX_SPEED) {
    const scale = SHIP_MAX_SPEED / speed;
    body.vx *= scale;
    body.vy *= scale;
  }

  body.x = wrap(body.x + body.vx * dt, WORLD_W);
  body.y = wrap(body.y + body.vy * dt, WORLD_H);
}

export function steer(ang: number, input: number, aim: number, dt: number): number {
  const step = SHIP_TURN_RATE * dt;

  if (input & INPUT_AIM) {
    const error = angleDelta(ang, aim);
    // Settling inside the deadband rather than turning by the full step is what
    // stops a pointer-steered ship from oscillating around its own heading.
    if (Math.abs(error) <= AIM_SETTLED) return normalize(aim);
    return normalize(ang + Math.sign(error) * Math.min(step, Math.abs(error)));
  }

  let next = ang;
  if (input & INPUT_LEFT) next -= step;
  if (input & INPUT_RIGHT) next += step;
  return normalize(next);
}

export function normalize(ang: number): number {
  return ((ang % TAU) + TAU) % TAU;
}

export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

export function wrap(value: number, span: number): number {
  if (value < 0) return value + span * Math.ceil(-value / span);
  if (value >= span) return value % span;
  return value;
}

/** Shortest delta on a wrapping axis, so nothing at the seam looks far away. */
export function axisDelta(from: number, to: number, span: number): number {
  let delta = to - from;
  if (delta > span / 2) delta -= span;
  if (delta < -span / 2) delta += span;
  return delta;
}

export function torusDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(axisDelta(ax, bx, WORLD_W), axisDelta(ay, by, WORLD_H));
}

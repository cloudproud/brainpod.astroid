import {
  EVENT_ROCK_BURST,
  EVENT_SHIP_EXPLODE,
  EVENT_SPAWN,
  ROCK_RADII,
  SHIP_RADIUS,
  WORLD_H,
  WORLD_W,
} from "@/shared/constants";
import type { EventWire } from "@/shared/protocol";
import { wrap } from "@/shared/physics";
import { PALETTE, shipColor } from "./palette";
import type { RenderFrame } from "./net";

/** Below this the whole arena is too small to fly in, so the camera follows instead. */
const MIN_FIT_ZOOM = 0.34;
const STAR_COUNT = 220;
const MAX_PARTICLES = 420;

const TAU = Math.PI * 2;

const TINT_BONE = 0;
const TINT_EMBER = 1;
const TINT_GOLD = 2;
const TINTS = [PALETTE.bone, PALETTE.ember, PALETTE.gold];

/**
 * Particles and stars are drawn in batches, one path per bucket, so their alpha
 * is quantized to a handful of steps instead of being set per item. Six steps is
 * fine enough that a fading spark still reads as a fade.
 */
const FADE_STEPS = 6;
const FADE_ALPHAS = [0.075, 0.225, 0.375, 0.525, 0.675, 0.825];
const STAR_ALPHAS = [0.14, 0.23, 0.32, 0.41];
const PARTICLE_BUCKETS = TINTS.length * FADE_STEPS * 2;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  tint: number;
  wide: boolean;
};

type Ring = {
  x: number;
  y: number;
  radius: number;
  life: number;
  growth: number;
  color: string;
};

type Star = { x: number; y: number; size: number; bucket: number };

export class Renderer {
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private stars: Star[] = createStars();
  private particleBuckets: number[][] = Array.from(
    { length: PARTICLE_BUCKETS },
    () => [],
  );
  private shake = 0;
  private time = 0;
  private monoFamily = "monospace";
  private font = "";

  private viewWidth = 0;
  private viewHeight = 0;
  private dpr = 1;
  private zoom = 1;
  private center = { x: WORLD_W / 2, y: WORLD_H / 2 };
  private originX = 0;
  private originY = 0;

  private backdrop: CanvasGradient | null = null;
  private geometryZoom = -1;
  private rockPaths = new Map<number, Path2D>();
  private hullPath = new Path2D();

  setMonoFamily(family: string): void {
    this.monoFamily = family || "monospace";
    this.font = "";
  }

  /**
   * Canvas size in CSS pixels, plus the ratio its backing store was sized at.
   * Resizing a canvas resets its context, so the cached font goes with it.
   */
  resize(width: number, height: number, dpr: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.dpr = dpr;
    this.backdrop = null;
    this.font = "";
  }

  ingest(events: EventWire[], selfPosition: { x: number; y: number } | null): void {
    for (const event of events) {
      if (event.type === EVENT_ROCK_BURST) {
        const count = 8 + (2 - event.mag) * 5;
        this.burst(event.x, event.y, count, TINT_BONE, 90 + (2 - event.mag) * 45);
      } else if (event.type === EVENT_SHIP_EXPLODE) {
        this.burst(event.x, event.y, 26, TINT_EMBER, 230);
        this.burst(event.x, event.y, 12, TINT_GOLD, 140);
        this.rings.push({
          x: event.x,
          y: event.y,
          radius: 6,
          life: 1,
          growth: 150,
          color: PALETTE.ember,
        });
        if (selfPosition && torusDistance(selfPosition, event) < 260) {
          this.shake = Math.min(1, this.shake + 0.9);
        }
      } else if (event.type === EVENT_SPAWN) {
        this.rings.push({
          x: event.x,
          y: event.y,
          radius: 3,
          life: 1,
          growth: 90,
          color: PALETTE.beam,
        });
      }
    }
  }

  private burst(x: number, y: number, count: number, tint: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) break;
      const angle = Math.random() * TAU;
      const magnitude = speed * (0.35 + Math.random() * 0.85);
      const maxLife = 0.4 + Math.random() * 0.6;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * magnitude,
        vy: Math.sin(angle) * magnitude,
        life: maxLife,
        maxLife,
        tint,
        wide: Math.random() < 0.5,
      });
    }
  }

  step(dt: number): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.6);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.life -= dt;
      if (particle.life <= 0) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= 0.985;
      particle.vy *= 0.985;
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life -= dt * 3.2;
      if (ring.life <= 0) {
        this.rings[i] = this.rings[this.rings.length - 1];
        this.rings.pop();
        continue;
      }
      ring.radius += dt * ring.growth;
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    selfPosition: { x: number; y: number } | null,
  ): void {
    const width = this.viewWidth;
    const height = this.viewHeight;
    if (width <= 0 || height <= 0) return;

    const fit = Math.min(width / WORLD_W, height / WORLD_H);
    const following = fit < MIN_FIT_ZOOM;

    // Following zooms in at least far enough to cover the viewport. Any looser
    // and a phone in portrait would see past the edge of a wrapping world, into
    // dead space no entity is ever projected into.
    const cover = Math.max(width / WORLD_W, height / WORLD_H);
    const zoom = following ? Math.max(MIN_FIT_ZOOM, cover) : fit;

    this.zoom = zoom;
    if (following && selfPosition) {
      this.center.x = selfPosition.x;
      this.center.y = selfPosition.y;
    } else {
      this.center.x = WORLD_W / 2;
      this.center.y = WORLD_H / 2;
    }

    const shake = this.shake;
    this.originX = width / 2 + (shake ? (Math.random() - 0.5) * 14 * shake : 0);
    this.originY = height / 2 + (shake ? (Math.random() - 0.5) * 14 * shake : 0);

    if (zoom !== this.geometryZoom) this.rebuildGeometry(zoom);

    this.reset(ctx);
    ctx.lineJoin = "round";
    this.drawBackdrop(ctx, width, height);
    this.drawStars(ctx);

    if (!following) this.drawArena(ctx, zoom);

    this.drawRocks(ctx, frame, zoom);
    this.drawBullets(ctx, frame, zoom);
    this.drawParticles(ctx, zoom);
    this.drawRings(ctx);
    this.drawShips(ctx, frame, zoom);
  }

  /**
   * Rock and hull outlines are the same handful of shapes at whatever size the
   * current zoom implies, and zoom only moves when the window does — so they are
   * baked into paths rather than traced point by point every frame. Rocks build
   * on first sight: a drag-resize would otherwise mint 192 paths per event.
   */
  private rebuildGeometry(zoom: number): void {
    this.geometryZoom = zoom;
    this.rockPaths.clear();

    const scale = SHIP_RADIUS * zoom;
    const hull = new Path2D();
    hull.moveTo(1.25 * scale, 0);
    hull.lineTo(-0.8 * scale, 0.72 * scale);
    hull.lineTo(-0.42 * scale, 0);
    hull.lineTo(-0.8 * scale, -0.72 * scale);
    hull.closePath();
    this.hullPath = hull;
  }

  private rockPath(shape: number, size: number): Path2D {
    const key = shape * 4 + size;
    const cached = this.rockPaths.get(key);
    if (cached) return cached;

    const radius = ROCK_RADII[size] * this.geometryZoom;
    const points = rockPoints(shape, size);
    const path = new Path2D();

    for (let i = 0; i < points.length; i += 2) {
      const x = points[i] * radius;
      const y = points[i + 1] * radius;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }

    path.closePath();
    this.rockPaths.set(key, path);
    return path;
  }

  private projectX(x: number): number {
    return this.originX + delta(this.center.x, x, WORLD_W) * this.zoom;
  }

  private projectY(y: number): number {
    return this.originY + delta(this.center.y, y, WORLD_H) * this.zoom;
  }

  private reset(ctx: CanvasRenderingContext2D): void {
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Translate and rotate without touching the state stack. */
  private place(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number): void {
    const dpr = this.dpr;
    const cos = Math.cos(ang) * dpr;
    const sin = Math.sin(ang) * dpr;
    ctx.setTransform(cos, sin, -sin, cos, x * dpr, y * dpr);
  }

  private drawBackdrop(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    if (!this.backdrop) {
      const gradient = ctx.createRadialGradient(
        width / 2,
        height / 2,
        0,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.72,
      );
      gradient.addColorStop(0, "#12110e");
      gradient.addColorStop(1, PALETTE.void);
      this.backdrop = gradient;
    }

    // Opaque and full-bleed, so it is also the clear.
    ctx.fillStyle = this.backdrop;
    ctx.fillRect(0, 0, width, height);
  }

  /** The star list is sorted by brightness, so one pass closes out each batch. */
  private drawStars(ctx: CanvasRenderingContext2D): void {
    const zoom = this.zoom;
    const width = this.viewWidth;
    const height = this.viewHeight;
    ctx.fillStyle = PALETTE.bone;

    let bucket = -1;
    let opened = false;

    for (const star of this.stars) {
      if (star.bucket !== bucket) {
        if (opened) {
          ctx.globalAlpha = STAR_ALPHAS[bucket];
          ctx.fill();
          opened = false;
        }
        bucket = star.bucket;
      }

      const sx = this.projectX(star.x);
      if (sx < -4 || sx > width) continue;
      const sy = this.projectY(star.y);
      if (sy < -4 || sy > height) continue;

      if (!opened) {
        ctx.beginPath();
        opened = true;
      }
      const size = star.size * zoom * 2;
      ctx.rect(sx, sy, size, size);
    }

    if (opened) {
      ctx.globalAlpha = STAR_ALPHAS[bucket];
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawArena(ctx: CanvasRenderingContext2D, zoom: number): void {
    const left = this.projectX(0);
    const top = this.projectY(0);
    const width = WORLD_W * zoom;
    const height = WORLD_H * zoom;

    ctx.strokeStyle = PALETTE.edge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left, top, width, height);

    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    for (let i = 1; i < 6; i++) {
      const x = left + (width / 6) * i;
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + height);
    }
    for (let i = 1; i < 4; i++) {
      const y = top + (height / 4) * i;
      ctx.moveTo(left, y);
      ctx.lineTo(left + width, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawRocks(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    zoom: number,
  ): void {
    if (!frame.rocks.length) return;
    const width = Math.max(1, 1.4 * zoom + 0.4);

    for (const rock of frame.rocks) {
      const sx = this.projectX(rock.x);
      const sy = this.projectY(rock.y);
      const radius = ROCK_RADII[rock.size] * zoom;
      if (this.offscreen(sx, sy, radius)) continue;

      this.place(ctx, sx, sy, rock.ang);
      strokeGlow(ctx, this.rockPath(rock.shape, rock.size), PALETTE.faint, width, 0.1, 1);
    }

    this.reset(ctx);
  }

  /**
   * Every bullet is one of two colours over the same white core, so the whole
   * volley is three fills rather than two per bullet.
   */
  private drawBullets(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    zoom: number,
  ): void {
    if (!frame.bullets.length) return;
    const radius = Math.max(1.6, 2.6 * zoom);
    const glow = radius * 2.6;

    for (let pass = 0; pass < 2; pass++) {
      let opened = false;
      for (const bullet of frame.bullets) {
        if (bullet.bot !== (pass === 1)) continue;
        const sx = this.projectX(bullet.x);
        const sy = this.projectY(bullet.y);
        if (this.offscreen(sx, sy, glow)) continue;
        if (!opened) {
          ctx.beginPath();
          opened = true;
        }
        ctx.moveTo(sx + glow, sy);
        ctx.arc(sx, sy, glow, 0, TAU);
      }
      if (!opened) continue;
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = pass === 1 ? PALETTE.teal : PALETTE.beam;
      ctx.fill();
    }

    let opened = false;
    for (const bullet of frame.bullets) {
      const sx = this.projectX(bullet.x);
      const sy = this.projectY(bullet.y);
      if (this.offscreen(sx, sy, radius)) continue;
      if (!opened) {
        ctx.beginPath();
        opened = true;
      }
      ctx.moveTo(sx + radius, sy);
      ctx.arc(sx, sy, radius, 0, TAU);
    }
    if (opened) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = PALETTE.bone;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  private drawParticles(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (!this.particles.length) return;

    const buckets = this.particleBuckets;
    for (const bucket of buckets) bucket.length = 0;

    const width = this.viewWidth;
    const height = this.viewHeight;

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      const sx = this.projectX(particle.x);
      if (sx < -24 || sx > width + 24) continue;
      const sy = this.projectY(particle.y);
      if (sy < -24 || sy > height + 24) continue;

      const fade = particle.life / particle.maxLife;
      const step = Math.min(FADE_STEPS - 1, Math.max(0, Math.floor(fade * FADE_STEPS)));
      buckets[(particle.tint * FADE_STEPS + step) * 2 + (particle.wide ? 1 : 0)].push(i);
    }

    const stroke = Math.max(zoom, 0.5);

    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      if (!bucket.length) continue;

      const group = b >> 1;
      ctx.globalAlpha = FADE_ALPHAS[group % FADE_STEPS];
      ctx.strokeStyle = TINTS[(group / FADE_STEPS) | 0];
      ctx.lineWidth = ((b & 1) === 1 ? 2 : 1.2) * stroke;
      ctx.beginPath();

      for (const i of bucket) {
        const particle = this.particles[i];
        const sx = this.projectX(particle.x);
        const sy = this.projectY(particle.y);
        ctx.moveTo(sx - particle.vx * 0.02 * zoom, sy - particle.vy * 0.02 * zoom);
        ctx.lineTo(sx, sy);
      }

      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  private drawRings(ctx: CanvasRenderingContext2D): void {
    if (!this.rings.length) return;
    ctx.lineWidth = 1.5;

    for (const ring of this.rings) {
      const radius = ring.radius * this.zoom;
      const sx = this.projectX(ring.x);
      const sy = this.projectY(ring.y);
      if (this.offscreen(sx, sy, radius)) continue;

      ctx.globalAlpha = ring.life * ring.life * 0.7;
      ctx.strokeStyle = ring.color;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, TAU);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  private drawShips(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    zoom: number,
  ): void {
    if (!frame.ships.length) return;

    const scale = SHIP_RADIUS * zoom;
    const hullWidth = Math.max(1.2, 1.7 * zoom + 0.5);
    const flareWidth = Math.max(1, 1.2 * zoom + 0.3);

    for (const ship of frame.ships) {
      const sx = this.projectX(ship.x);
      const sy = this.projectY(ship.y);
      if (this.offscreen(sx, sy, scale * 4)) continue;

      const base = ship.invulnerable && Math.floor(this.time * 8) % 2 === 0 ? 0.28 : 1;
      const color = ship.self ? PALETTE.bone : shipColor(ship.id, ship.bot);

      this.place(ctx, sx, sy, ship.ang);

      if (ship.thrusting) {
        const flare = 0.6 + Math.random() * 0.55;
        ctx.beginPath();
        ctx.moveTo(-0.5 * scale, -0.34 * scale);
        ctx.lineTo(-(0.7 + flare) * scale, 0);
        ctx.lineTo(-0.5 * scale, 0.34 * scale);
        ctx.strokeStyle = PALETTE.gold;
        ctx.lineWidth = flareWidth;
        ctx.globalAlpha = base * (0.55 + Math.random() * 0.45);
        ctx.stroke();
      }

      strokeGlow(ctx, this.hullPath, color, hullWidth, ship.self ? 0.2 : 0.13, base);
    }

    this.reset(ctx);
    this.drawNames(ctx, frame, zoom, scale);
    ctx.globalAlpha = 1;
  }

  private drawNames(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    zoom: number,
    scale: number,
  ): void {
    if (zoom <= 0.2) return;

    const size = Math.max(9, Math.round(11 * Math.min(zoom * 1.4, 1.3)));
    const font = `${size}px ${this.monoFamily}`;
    // Assigning `font` reparses the shorthand, so only do it when it changed.
    if (font !== this.font) {
      this.font = font;
      ctx.font = font;
    }
    ctx.textAlign = "center";

    for (const ship of frame.ships) {
      if (!ship.name) continue;
      const sx = this.projectX(ship.x);
      const sy = this.projectY(ship.y);
      if (this.offscreen(sx, sy, scale * 4)) continue;

      ctx.globalAlpha = ship.self ? 0.9 : 0.6;
      ctx.fillStyle = ship.self ? PALETTE.bone : shipColor(ship.id, ship.bot);
      ctx.fillText(ship.name, sx, sy - scale * 1.9);
    }
  }

  /**
   * Screen point to world point, using the view the last frame was drawn with.
   * Pointer steering needs it, and it has to agree with the projection exactly or
   * the ship flies somewhere the cursor is not.
   */
  toWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: wrap(this.center.x + (screenX - this.viewWidth / 2) / this.zoom, WORLD_W),
      y: wrap(this.center.y + (screenY - this.viewHeight / 2) / this.zoom, WORLD_H),
    };
  }

  private offscreen(x: number, y: number, margin: number): boolean {
    return (
      x < -margin ||
      y < -margin ||
      x > this.viewWidth + margin ||
      y > this.viewHeight + margin
    );
  }
}

/**
 * Two passes, not three: a wide faint halo plus the line itself. The widest pass
 * a third version had cost more fill than it added glow.
 */
function strokeGlow(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  color: string,
  width: number,
  glowAlpha: number,
  baseAlpha: number,
): void {
  ctx.strokeStyle = color;

  ctx.globalAlpha = baseAlpha * glowAlpha * 2.6;
  ctx.lineWidth = width * 2.8;
  ctx.stroke(path);

  ctx.globalAlpha = baseAlpha;
  ctx.lineWidth = width;
  ctx.stroke(path);
}

const rockCache = new Map<number, number[]>();

/** Flat x,y pairs on the unit circle — scaled into a path once per zoom. */
function rockPoints(shape: number, size: number): number[] {
  const key = shape * 4 + size;
  const cached = rockCache.get(key);
  if (cached) return cached;

  const vertices = 9 + (shape % 3);
  const points: number[] = [];
  let seed = shape * 2654435761 + size * 40503;

  for (let i = 0; i < vertices; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const jitter = 0.74 + ((seed >> 8) % 1000) / 1000 / 3.2;
    const angle = (i / vertices) * TAU;
    points.push(Math.cos(angle) * jitter, Math.sin(angle) * jitter);
  }

  rockCache.set(key, points);
  return points;
}

function createStars(): Star[] {
  const stars: Star[] = [];
  let seed = 987654321;
  for (let i = 0; i < STAR_COUNT; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = ((seed >> 6) % 100000) / 100000;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const y = ((seed >> 6) % 100000) / 100000;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const brightness = ((seed >> 6) % 1000) / 1000;
    stars.push({
      x: x * WORLD_W,
      y: y * WORLD_H,
      size: brightness > 0.9 ? 1.1 : 0.65,
      bucket: Math.min(STAR_ALPHAS.length - 1, Math.floor(brightness * STAR_ALPHAS.length)),
    });
  }
  stars.sort((a, b) => a.bucket - b.bucket);
  return stars;
}

function delta(from: number, to: number, span: number): number {
  const value = to - from;
  if (value > span / 2) return value - span;
  if (value < -span / 2) return value + span;
  return value;
}

function torusDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(delta(a.x, b.x, WORLD_W), delta(a.y, b.y, WORLD_H));
}

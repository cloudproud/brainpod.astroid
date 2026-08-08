import {
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_TTL_MS,
  EVENT_ROCK_BURST,
  EVENT_SHIP_EXPLODE,
  EVENT_SPAWN,
  FIRE_COOLDOWN_MS,
  INPUT_FIRE,
  INPUT_MASK,
  INVULN_MS,
  MAX_SHIPS,
  RESPAWN_MS,
  ROCK_RADII,
  ROCK_SCORES,
  ROCK_SPEEDS,
  ROCK_TARGET,
  SHIP_FLAG_BOT,
  SHIP_FLAG_INVULN,
  SHIP_FLAG_THRUST,
  SHIP_RADIUS,
  INPUT_THRUST,
  WORLD_H,
  WORLD_W,
} from "../shared/constants";
import {
  axisDelta,
  stepKinematics,
  torusDistance,
  wrap,
} from "../shared/physics";
import { packAngle, type EventWire, type Snapshot } from "../shared/protocol";

const TAU = Math.PI * 2;

export type Ship = {
  id: number;
  playerId: string;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ang: number;
  input: number;
  /** Heading the ship steers toward while INPUT_AIM is set, in radians. */
  aim: number;
  alive: boolean;
  respawnAt: number;
  invulnUntil: number;
  cooldownUntil: number;
  score: number;
  kills: number;
  asteroids: number;
  spawnedAt: number;
};

export type Bullet = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dieAt: number;
  owner: number;
  fromBot: boolean;
};

export type Rock = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ang: number;
  spin: number;
  size: number;
  shape: number;
};

export type WorldState = {
  tick: number;
  nextId: number;
  ships: Ship[];
  bullets: Bullet[];
  rocks: Rock[];
  savedAt: number;
};

export type DeathReport = {
  playerId: string;
  name: string;
  bot: boolean;
  score: number;
  kills: number;
  asteroids: number;
  survivedMs: number;
  by: string;
};

export type AddShipRequest = { playerId: string; name: string; bot: boolean };

export class Sim {
  world: WorldState;
  private events: EventWire[] = [];
  private deaths: DeathReport[] = [];
  private byPlayer = new Map<string, Ship>();
  private byId = new Map<number, Ship>();
  private humans = 0;
  private bots = 0;

  constructor(world?: WorldState) {
    this.world = world ?? Sim.freshWorld();
    for (const ship of this.world.ships) this.index(ship);
  }

  static freshWorld(): WorldState {
    const world: WorldState = {
      tick: 0,
      nextId: 1,
      ships: [],
      bullets: [],
      rocks: [],
      savedAt: Date.now(),
    };
    for (let i = 0; i < ROCK_TARGET; i++) {
      world.rocks.push(makeRock(world, 0, randomEdgePosition()));
    }
    return world;
  }

  static deserialize(raw: string): WorldState | null {
    try {
      const parsed = JSON.parse(raw) as WorldState;
      if (!parsed || !Array.isArray(parsed.ships) || !Array.isArray(parsed.rocks)) {
        return null;
      }
      parsed.bullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
      return parsed;
    } catch {
      return null;
    }
  }

  serialize(): string {
    this.world.savedAt = Date.now();
    return JSON.stringify(this.world);
  }

  shipFor(playerId: string): Ship | undefined {
    return this.byPlayer.get(playerId);
  }

  humanCount(): number {
    return this.humans;
  }

  botCount(): number {
    return this.bots;
  }

  hasCapacity(): boolean {
    return this.world.ships.length < MAX_SHIPS;
  }

  addShip(request: AddShipRequest): Ship | null {
    const existing = this.byPlayer.get(request.playerId);
    if (existing) return existing;

    if (!this.hasCapacity()) {
      if (request.bot) return null;
      const victim = this.world.ships.find((ship) => ship.bot);
      if (!victim) return null;
      this.removeShip(victim.playerId);
    }

    const now = Date.now();
    const spot = this.safeSpawn();
    const ship: Ship = {
      id: this.takeShipId(),
      playerId: request.playerId,
      name: request.name,
      bot: request.bot,
      x: spot.x,
      y: spot.y,
      vx: 0,
      vy: 0,
      ang: Math.random() * TAU,
      input: 0,
      aim: 0,
      alive: true,
      respawnAt: 0,
      invulnUntil: now + INVULN_MS,
      cooldownUntil: 0,
      score: 0,
      kills: 0,
      asteroids: 0,
      spawnedAt: now,
    };
    this.world.ships.push(ship);
    this.index(ship);
    this.events.push({ type: EVENT_SPAWN, x: ship.x, y: ship.y, mag: 1 });
    return ship;
  }

  removeShip(playerId: string): void {
    const ship = this.byPlayer.get(playerId);
    if (!ship) return;
    const index = this.world.ships.indexOf(ship);
    if (index >= 0) this.world.ships.splice(index, 1);
    this.byPlayer.delete(ship.playerId);
    this.byId.delete(ship.id);
    if (ship.bot) this.bots--;
    else this.humans--;
  }

  private index(ship: Ship): void {
    this.byPlayer.set(ship.playerId, ship);
    this.byId.set(ship.id, ship);
    if (ship.bot) this.bots++;
    else this.humans++;
  }

  setInput(playerId: string, bits: number, aim: number | null): void {
    const ship = this.byPlayer.get(playerId);
    if (!ship || ship.bot) return;
    ship.input = bits & INPUT_MASK;
    if (aim !== null) ship.aim = aim;
  }

  takeDeaths(): DeathReport[] {
    const deaths = this.deaths;
    this.deaths = [];
    return deaths;
  }

  step(dt: number, now: number): void {
    const world = this.world;
    world.tick++;

    for (const ship of world.ships) {
      if (!ship.alive) {
        if (now >= ship.respawnAt) this.respawn(ship, now);
        continue;
      }
      this.stepShip(ship, dt, now);
    }

    for (let i = world.bullets.length - 1; i >= 0; i--) {
      const bullet = world.bullets[i];
      if (now >= bullet.dieAt) {
        world.bullets.splice(i, 1);
        continue;
      }
      bullet.x = wrap(bullet.x + bullet.vx * dt, WORLD_W);
      bullet.y = wrap(bullet.y + bullet.vy * dt, WORLD_H);
    }

    for (const rock of world.rocks) {
      rock.x = wrap(rock.x + rock.vx * dt, WORLD_W);
      rock.y = wrap(rock.y + rock.vy * dt, WORLD_H);
      rock.ang = (rock.ang + rock.spin * dt) % TAU;
    }

    this.collide(now);
    this.replenish();
  }

  private stepShip(ship: Ship, dt: number, now: number): void {
    stepKinematics(ship, ship.input, ship.aim, dt);

    if (ship.input & INPUT_FIRE && now >= ship.cooldownUntil) {
      ship.cooldownUntil = now + FIRE_COOLDOWN_MS;
      const nose = SHIP_RADIUS + 4;
      const dirX = Math.cos(ship.ang);
      const dirY = Math.sin(ship.ang);
      this.world.bullets.push({
        id: this.takeId(),
        x: wrap(ship.x + dirX * nose, WORLD_W),
        y: wrap(ship.y + dirY * nose, WORLD_H),
        vx: dirX * BULLET_SPEED + ship.vx * 0.35,
        vy: dirY * BULLET_SPEED + ship.vy * 0.35,
        dieAt: now + BULLET_TTL_MS,
        owner: ship.id,
        fromBot: ship.bot,
      });
    }
  }

  private collide(now: number): void {
    const world = this.world;

    // Bullets hit rocks and nothing else. There is no player-versus-player here:
    // the arena is a shared score attack, so shots pass straight through ships.
    for (let b = world.bullets.length - 1; b >= 0; b--) {
      const bullet = world.bullets[b];

      for (let r = world.rocks.length - 1; r >= 0; r--) {
        const rock = world.rocks[r];
        const radius = ROCK_RADII[rock.size] + BULLET_RADIUS;
        if (!near(bullet.x, bullet.y, rock.x, rock.y, radius)) continue;

        world.rocks.splice(r, 1);
        world.bullets.splice(b, 1);
        this.splitRock(rock);
        this.events.push({
          type: EVENT_ROCK_BURST,
          x: rock.x,
          y: rock.y,
          mag: rock.size,
        });

        const owner = this.byId.get(bullet.owner);
        if (owner) {
          owner.score += ROCK_SCORES[rock.size];
          owner.asteroids++;
        }
        break;
      }
    }

    for (const ship of world.ships) {
      if (!ship.alive || now < ship.invulnUntil) continue;
      for (const rock of world.rocks) {
        if (!near(ship.x, ship.y, rock.x, rock.y, SHIP_RADIUS + ROCK_RADII[rock.size])) {
          continue;
        }
        this.hit(ship, now);
        break;
      }
    }
  }

  /**
   * One touch ends the run: the score becomes a row in Postgres, and three
   * seconds later the ship comes back from zero.
   */
  private hit(ship: Ship, now: number): void {
    ship.alive = false;
    ship.respawnAt = now + RESPAWN_MS;
    ship.vx = 0;
    ship.vy = 0;
    ship.input = 0;

    this.events.push({ type: EVENT_SHIP_EXPLODE, x: ship.x, y: ship.y, mag: 1 });
    this.deaths.push({
      playerId: ship.playerId,
      name: ship.name,
      bot: ship.bot,
      score: ship.score,
      kills: ship.kills,
      asteroids: ship.asteroids,
      survivedMs: Math.max(0, now - ship.spawnedAt),
      by: "an asteroid",
    });
  }

  private respawn(ship: Ship, now: number): void {
    const spot = this.safeSpawn();
    ship.x = spot.x;
    ship.y = spot.y;
    ship.vx = 0;
    ship.vy = 0;
    ship.ang = Math.random() * TAU;
    ship.aim = ship.ang;
    ship.alive = true;
    ship.invulnUntil = now + INVULN_MS;
    ship.cooldownUntil = 0;
    ship.score = 0;
    ship.kills = 0;
    ship.asteroids = 0;
    ship.spawnedAt = now;

    this.events.push({ type: EVENT_SPAWN, x: ship.x, y: ship.y, mag: 1 });
  }

  private splitRock(rock: Rock): void {
    if (rock.size >= ROCK_RADII.length - 1) return;
    const size = rock.size + 1;
    const base = Math.atan2(rock.vy, rock.vx);
    for (const turn of [-1, 1]) {
      const angle = base + turn * (0.5 + Math.random() * 0.7);
      const [min, max] = ROCK_SPEEDS[size];
      const speed = min + Math.random() * (max - min);
      this.world.rocks.push({
        id: this.takeId(),
        x: rock.x,
        y: rock.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        ang: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 1.8,
        size,
        shape: Math.floor(Math.random() * 64),
      });
    }
  }

  private replenish(): void {
    const rocks = this.world.rocks;
    if (rocks.length > 90) return;

    let weight = 0;
    for (const rock of rocks) weight += 1 / (1 << rock.size);
    if (weight >= ROCK_TARGET) return;

    this.world.rocks.push(makeRock(this.world, 0, randomEdgePosition()));
  }

  private safeSpawn(): { x: number; y: number } {
    let best = { x: WORLD_W / 2, y: WORLD_H / 2 };
    let bestClearance = -1;

    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = {
        x: 120 + Math.random() * (WORLD_W - 240),
        y: 120 + Math.random() * (WORLD_H - 240),
      };
      let clearance = Infinity;
      for (const rock of this.world.rocks) {
        clearance = Math.min(
          clearance,
          torusDistance(candidate.x, candidate.y, rock.x, rock.y) - ROCK_RADII[rock.size],
        );
      }
      for (const ship of this.world.ships) {
        if (!ship.alive) continue;
        clearance = Math.min(
          clearance,
          torusDistance(candidate.x, candidate.y, ship.x, ship.y),
        );
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = candidate;
      }
      if (clearance > 200) break;
    }

    return best;
  }

  private takeId(): number {
    const id = this.world.nextId;
    this.world.nextId = (this.world.nextId % 65000) + 1;
    return id;
  }

  /**
   * Ids are 16 bits and bullets burn through them in about twenty minutes, so a
   * long-lived ship will eventually see its number come back around. Two ships
   * sharing one would break both the score lookup and client interpolation.
   */
  private takeShipId(): number {
    let id = this.takeId();
    while (this.byId.has(id)) id = this.takeId();
    return id;
  }

  snapshot(): Snapshot {
    const now = Date.now();
    const events = this.events;
    this.events = [];

    return {
      tick: this.world.tick,
      ships: this.world.ships
        .filter((ship) => ship.alive)
        .map((ship) => ({
          id: ship.id,
          x: ship.x,
          y: ship.y,
          ang: packAngle(ship.ang),
          flags:
            (ship.input & INPUT_THRUST ? SHIP_FLAG_THRUST : 0) |
            (now < ship.invulnUntil ? SHIP_FLAG_INVULN : 0) |
            (ship.bot ? SHIP_FLAG_BOT : 0),
        })),
      bullets: this.world.bullets.map((bullet) => ({
        id: bullet.id,
        x: bullet.x,
        y: bullet.y,
        flags: bullet.fromBot ? 1 : 0,
      })),
      rocks: this.world.rocks.map((rock) => ({
        id: rock.id,
        x: rock.x,
        y: rock.y,
        ang: packAngle(rock.ang),
        size: rock.size,
        shape: rock.shape,
      })),
      events: events.slice(0, 40),
    };
  }
}

function makeRock(world: WorldState, size: number, at: { x: number; y: number }): Rock {
  const [min, max] = ROCK_SPEEDS[size];
  const speed = min + Math.random() * (max - min);
  const angle = Math.random() * TAU;
  const id = world.nextId;
  world.nextId = (world.nextId % 65000) + 1;
  return {
    id,
    x: at.x,
    y: at.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    ang: Math.random() * TAU,
    spin: (Math.random() - 0.5) * 1.2,
    size,
    shape: Math.floor(Math.random() * 64),
  };
}

function randomEdgePosition(): { x: number; y: number } {
  return Math.random() < 0.5
    ? { x: Math.random() < 0.5 ? 0 : WORLD_W, y: Math.random() * WORLD_H }
    : { x: Math.random() * WORLD_W, y: Math.random() < 0.5 ? 0 : WORLD_H };
}

function near(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  const dx = axisDelta(ax, bx, WORLD_W);
  if (Math.abs(dx) > radius) return false;
  const dy = axisDelta(ay, by, WORLD_H);
  if (Math.abs(dy) > radius) return false;
  return dx * dx + dy * dy <= radius * radius;
}

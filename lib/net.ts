import {
  AIM_DEADZONE,
  INPUT_AIM,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_THRUST,
  INTERP_DELAY_MS,
  RECONCILE_SNAP,
  SHIP_FLAG_BOT,
  SHIP_FLAG_INVULN,
  SHIP_FLAG_THRUST,
  TICK_MS,
  WORLD_H,
  WORLD_W,
} from "@/shared/constants";
import {
  angleDelta,
  axisDelta,
  stepKinematics,
  wrap,
} from "@/shared/physics";
import {
  decodeSnapshot,
  packAngle,
  unpackAngle,
  type BoardEntry,
  type EventWire,
  type RosterEntry,
  type RunEntry,
  type ServerMessage,
  type Snapshot,
} from "@/shared/protocol";

const HISTORY_MS = 900;
const DELAY_TICKS = INTERP_DELAY_MS / TICK_MS;
const NO_EVENTS: EventWire[] = [];

export type Phase = "menu" | "joining" | "playing" | "dead" | "spectating";

export type DeathSummary = {
  score: number;
  asteroids: number;
  survivedMs: number;
  by: string;
};

export type HudState = {
  connection: "connecting" | "online" | "offline";
  phase: Phase;
  shipId: number | null;
  name: string;
  score: number;
  roster: RosterEntry[];
  humans: number;
  spectators: number;
  live: BoardEntry[];
  allTime: RunEntry[];
  today: RunEntry[];
  pod: string;
  replica: number;
  replicas: number;
  release: string;
  region: string;
  leader: boolean;
  rtt: number;
  death: DeathSummary | null;
  notice: string | null;
};

export type RenderShip = {
  id: number;
  x: number;
  y: number;
  ang: number;
  thrusting: boolean;
  invulnerable: boolean;
  bot: boolean;
  self: boolean;
  name: string;
};

export type RenderBullet = { x: number; y: number; bot: boolean };
export type RenderRock = { x: number; y: number; ang: number; size: number; shape: number };

export type RenderFrame = {
  ships: RenderShip[];
  bullets: RenderBullet[];
  rocks: RenderRock[];
};

const EMPTY_HUD: HudState = {
  connection: "connecting",
  phase: "menu",
  shipId: null,
  name: "",
  score: 0,
  roster: [],
  humans: 0,
  spectators: 0,
  live: [],
  allTime: [],
  today: [],
  pod: "",
  replica: 1,
  replicas: 1,
  release: "",
  region: "eu-west-1",
  leader: false,
  rtt: 0,
  death: null,
  notice: null,
};

type SnapshotIndex = {
  ships: Map<number, Snapshot["ships"][number]>;
  bullets: Map<number, Snapshot["bullets"][number]>;
  rocks: Map<number, Snapshot["rocks"][number]>;
};

type Buffered = { snap: Snapshot; emitted: boolean; index: SnapshotIndex | null };

type Predicted = {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ang: number;
};

/**
 * Owns the socket, the snapshot buffer and the local prediction of your own
 * ship. React subscribes to the HUD half, which changes a few times a second;
 * the render loop reads the frame half directly so it never waits on a render.
 */
export class GameClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private hud: HudState = EMPTY_HUD;

  private buffer: Buffered[] = [];
  private playbackTick = 0;
  private started = false;

  private input = 0;
  private aimTarget: { x: number; y: number } | null = null;
  private aimAngle = 0;
  private resolvedInput = 0;
  private resolvedAim: number | null = null;
  private sentInput = -1;
  private sentAim: number | null = null;
  private predicted: Predicted = { active: false, x: 0, y: 0, vx: 0, vy: 0, ang: 0 };
  private history: { t: number; x: number; y: number }[] = [];
  private pendingEvents: EventWire[] = [];

  private frame: RenderFrame = { ships: [], bullets: [], rocks: [] };
  private shipPool: RenderShip[] = [];
  private bulletPool: RenderBullet[] = [];
  private rockPool: RenderRock[] = [];

  private names = new Map<number, { name: string; bot: boolean }>();
  private desiredName: string | null = null;
  private reconnectAt = 0;
  private reconnectDelay = 200;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private session = restoreSession();

  /**
   * Input is flushed on its own timer rather than from the render loop:
   * requestAnimationFrame stops in a backgrounded tab, and a ship that stops
   * answering the keyboard because someone switched windows is indefensible.
   */
  start(): void {
    this.disposed = false;
    this.connect();
    this.inputTimer ??= setInterval(() => this.flushInput(), 33);
    this.pingTimer ??= setInterval(() => this.send({ t: "ping", c: Date.now() }), 2000);
  }

  connect(): void {
    if (this.disposed) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    // Every handler checks that it still owns the live socket: a dispose or a
    // reconnect can leave an older one draining, and a stale close event that
    // schedules its own retry is how you end up with two sockets.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 200;
      this.patch({ connection: "online", notice: null });
      if (this.desiredName) this.sendJoin(this.desiredName);
      this.sentInput = -1;
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (event.data instanceof ArrayBuffer) {
        this.onSnapshot(event.data);
        return;
      }
      try {
        this.onMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        /* a malformed frame is not worth tearing the session down for */
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket || this.disposed) return;
      this.socket = null;
      this.started = false;
      this.buffer = [];
      this.predicted.active = false;
      this.patch({ connection: "connecting" });
      this.reconnectAt = Date.now() + this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 4000);
    };

    socket.onerror = () => socket.close();
  }

  /** Symmetric with `start`, so a remount picks the session back up. */
  dispose(): void {
    this.disposed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.pingTimer = null;
    this.inputTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.started = false;
    this.buffer = [];
    this.history = [];
    this.pendingEvents = [];
    this.predicted.active = false;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getHud = (): HudState => this.hud;

  join(name: string): void {
    this.desiredName = name;
    this.patch({ phase: "joining", name, death: null, notice: null });
    this.sendJoin(name);
  }

  leave(): void {
    this.desiredName = null;
    this.predicted.active = false;
    this.patch({ phase: "menu", shipId: null, death: null });
    this.send({ t: "leave" });
  }

  spectate(): void {
    this.patch({ phase: "spectating" });
  }

  backToMenu(): void {
    this.patch({ phase: this.desiredName ? "playing" : "menu" });
  }

  /** Bits the keyboard and the fire button contribute; steering may override. */
  setInput(bits: number): void {
    this.input = bits & 0x0f;
  }

  /** World point the ship should fly toward, or null to hand back to the keys. */
  setAimTarget(target: { x: number; y: number } | null): void {
    this.aimTarget = target;
  }

  /**
   * Turns the raw keyboard bits and the pointer target into the one input the
   * server and the local prediction both act on. Arrow keys win while held, so
   * grabbing the keyboard mid-flight always takes the ship back.
   */
  private resolve(): void {
    let bits = this.input;
    let aim: number | null = null;
    const target = this.aimTarget;
    const steering = (bits & (INPUT_LEFT | INPUT_RIGHT)) !== 0;

    if (target && this.predicted.active && !steering) {
      const dx = axisDelta(this.predicted.x, target.x, WORLD_W);
      const dy = axisDelta(this.predicted.y, target.y, WORLD_H);
      const distance = Math.hypot(dx, dy);

      if (distance > 1) this.aimAngle = Math.atan2(dy, dx);
      bits |= INPUT_AIM;
      if (distance > AIM_DEADZONE) bits |= INPUT_THRUST;
      aim = packAngle(this.aimAngle);
    }

    this.resolvedInput = bits;
    this.resolvedAim = aim;
  }

  private flushInput(): void {
    if (this.disposed) return;
    if (!this.socket && Date.now() >= this.reconnectAt) this.connect();

    this.resolve();
    if (this.hud.phase !== "playing") return;

    const bits = this.resolvedInput;
    const aim = this.resolvedAim;
    // A moving ship re-aims every frame, so only a turn the player could see is
    // worth a packet.
    const turned =
      aim !== null &&
      (this.sentAim === null || Math.abs(shortestByte(this.sentAim, aim)) >= 2);

    if (bits === this.sentInput && !turned && (aim === null) === (this.sentAim === null)) {
      return;
    }

    this.sentInput = bits;
    this.sentAim = aim;
    this.send(aim === null ? { t: "input", b: bits } : { t: "input", b: bits, a: aim });
  }

  /** The session id is what lets a reconnect re-enter the same ship, score intact. */
  private sendJoin(name: string): void {
    this.send({ t: "join", name, session: this.session });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        this.patch({
          pod: message.pod,
          replica: message.replica,
          replicas: message.replicas,
          release: message.release,
          region: message.region,
          leader: message.leader,
        });
        break;

      case "meta":
        this.patch({
          replica: message.replica,
          replicas: message.replicas,
          leader: message.leader,
        });
        break;

      case "roster": {
        this.names = new Map(
          message.players.map((player) => [player.id, { name: player.name, bot: player.bot }]),
        );
        const mine = message.players.find((player) => player.id === this.hud.shipId);
        this.patch({
          roster: message.players,
          humans: message.humans,
          spectators: message.spectators,
          score: mine ? mine.score : this.hud.score,
        });
        break;
      }

      case "board":
        this.patch({
          live: message.live,
          allTime: message.allTime,
          today: message.today,
        });
        break;

      case "joined":
        this.patch({
          phase: "playing",
          shipId: message.shipId,
          death: null,
          notice: null,
        });
        break;

      case "queued":
        this.patch({
          phase: "joining",
          notice: "Arena full — you fly the moment a slot opens.",
        });
        break;

      case "rejected":
        this.desiredName = null;
        this.patch({ phase: "menu", notice: message.reason });
        break;

      case "died":
        this.predicted.active = false;
        this.patch({
          phase: "dead",
          death: {
            score: message.score,
            asteroids: message.asteroids,
            survivedMs: message.survivedMs,
            by: message.by,
          },
        });
        break;

      case "pong": {
        const sample = Date.now() - message.c;
        const rtt = this.hud.rtt ? Math.round(this.hud.rtt * 0.7 + sample * 0.3) : sample;
        if (rtt !== this.hud.rtt) this.patch({ rtt });
        break;
      }
    }
  }

  private onSnapshot(data: ArrayBuffer): void {
    const snap = decodeSnapshot(data);
    if (!snap) return;

    this.buffer.push({ snap, emitted: false, index: null });
    if (this.buffer.length > 40) this.buffer.shift();

    if (!this.started) {
      this.playbackTick = snap.tick - DELAY_TICKS;
      this.started = true;
    }

    this.reconcile(snap);
  }

  private reconcile(snap: Snapshot): void {
    const shipId = this.hud.shipId;
    if (shipId === null) return;

    const server = snap.ships.find((ship) => ship.id === shipId);
    if (!server) {
      this.predicted.active = false;
      return;
    }

    const angle = unpackAngle(server.ang);

    if (!this.predicted.active) {
      this.predicted = {
        active: true,
        x: server.x,
        y: server.y,
        vx: 0,
        vy: 0,
        ang: angle,
      };
      this.history = [];
      this.sentInput = -1;
      if (this.hud.phase !== "playing") this.patch({ phase: "playing" });
      return;
    }

    const at = Date.now() - Math.max(this.hud.rtt / 2, 15);
    const past = this.sampleHistory(at);
    const errorX = axisDelta(past.x, server.x, WORLD_W);
    const errorY = axisDelta(past.y, server.y, WORLD_H);

    if (Math.hypot(errorX, errorY) > RECONCILE_SNAP) {
      this.predicted.x = server.x;
      this.predicted.y = server.y;
      this.predicted.ang = angle;
      this.history = [];
      return;
    }

    this.predicted.x = wrap(this.predicted.x + errorX * 0.2, WORLD_W);
    this.predicted.y = wrap(this.predicted.y + errorY * 0.2, WORLD_H);
    this.predicted.ang += angleDelta(this.predicted.ang, angle) * 0.15;
  }

  private sampleHistory(at: number): { x: number; y: number } {
    if (!this.history.length) return { x: this.predicted.x, y: this.predicted.y };
    let best = this.history[0];
    for (const entry of this.history) {
      if (entry.t <= at) best = entry;
      else break;
    }
    return best;
  }

  /** Called once per animation frame, before sampling. */
  advance(dtMs: number): void {
    if (this.disposed) return;
    this.advancePlayback(dtMs);
    this.advancePrediction(dtMs / 1000);
  }

  private advancePlayback(dtMs: number): void {
    if (!this.started || !this.buffer.length) return;

    const latest = this.buffer[this.buffer.length - 1].snap.tick;
    const target = latest - DELAY_TICKS;
    const drift = target - this.playbackTick;

    if (Math.abs(drift) > 20) {
      this.playbackTick = target;
    } else {
      const rate = 1 + Math.max(-0.15, Math.min(0.15, drift * 0.08));
      this.playbackTick += (dtMs / TICK_MS) * rate;
    }

    for (const entry of this.buffer) {
      if (entry.emitted || entry.snap.tick > this.playbackTick) continue;
      entry.emitted = true;
      if (entry.snap.events.length) this.pendingEvents.push(...entry.snap.events);
    }

    while (this.buffer.length > 3 && this.buffer[1].snap.tick < this.playbackTick - 2) {
      this.buffer.shift();
    }
  }

  private advancePrediction(dt: number): void {
    const self = this.predicted;
    if (!self.active || this.hud.phase !== "playing") return;

    this.resolve();
    stepKinematics(self, this.resolvedInput, unpackAngle(this.resolvedAim ?? 0), dt);

    const now = Date.now();
    this.history.push({ t: now, x: self.x, y: self.y });
    while (this.history.length && now - this.history[0].t > HISTORY_MS) {
      this.history.shift();
    }
  }

  drainEvents(): EventWire[] {
    if (!this.pendingEvents.length) return NO_EVENTS;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  /**
   * Runs every animation frame, so nothing here allocates: the frame arrays and
   * the objects in them are reused, and the id lookups belong to the snapshot
   * rather than the frame — built once at 20 Hz instead of rebuilt at 120.
   */
  sample(): RenderFrame {
    const frame = this.frame;
    frame.ships.length = 0;
    frame.bullets.length = 0;
    frame.rocks.length = 0;
    if (!this.buffer.length) return frame;

    const [olderEntry, newer, alpha] = this.bracket();
    const older = indexOf(olderEntry);
    const selfId = this.hud.shipId;

    for (const ship of newer.ships) {
      const previous = older.ships.get(ship.id);
      const isSelf = ship.id === selfId;

      let x = ship.x;
      let y = ship.y;
      let ang = unpackAngle(ship.ang);

      if (previous) {
        x = lerpWrapped(previous.x, ship.x, alpha, WORLD_W);
        y = lerpWrapped(previous.y, ship.y, alpha, WORLD_H);
        ang = lerpAngle(unpackAngle(previous.ang), ang, alpha);
      }

      if (isSelf && this.predicted.active) {
        x = this.predicted.x;
        y = this.predicted.y;
        ang = this.predicted.ang;
      }

      const out = this.takeShip(frame.ships.length);
      out.id = ship.id;
      out.x = x;
      out.y = y;
      out.ang = ang;
      out.thrusting = (ship.flags & SHIP_FLAG_THRUST) !== 0;
      out.invulnerable = (ship.flags & SHIP_FLAG_INVULN) !== 0;
      out.bot = (ship.flags & SHIP_FLAG_BOT) !== 0;
      out.self = isSelf;
      out.name = this.names.get(ship.id)?.name ?? "";
      frame.ships.push(out);
    }

    for (const bullet of newer.bullets) {
      const previous = older.bullets.get(bullet.id);
      const out = this.takeBullet(frame.bullets.length);
      out.x = previous ? lerpWrapped(previous.x, bullet.x, alpha, WORLD_W) : bullet.x;
      out.y = previous ? lerpWrapped(previous.y, bullet.y, alpha, WORLD_H) : bullet.y;
      out.bot = (bullet.flags & 1) !== 0;
      frame.bullets.push(out);
    }

    for (const rock of newer.rocks) {
      const previous = older.rocks.get(rock.id);
      const out = this.takeRock(frame.rocks.length);
      out.x = previous ? lerpWrapped(previous.x, rock.x, alpha, WORLD_W) : rock.x;
      out.y = previous ? lerpWrapped(previous.y, rock.y, alpha, WORLD_H) : rock.y;
      out.ang = previous
        ? lerpAngle(unpackAngle(previous.ang), unpackAngle(rock.ang), alpha)
        : unpackAngle(rock.ang);
      out.size = rock.size;
      out.shape = rock.shape;
      frame.rocks.push(out);
    }

    return frame;
  }

  private takeShip(at: number): RenderShip {
    return (this.shipPool[at] ??= {
      id: 0,
      x: 0,
      y: 0,
      ang: 0,
      thrusting: false,
      invulnerable: false,
      bot: false,
      self: false,
      name: "",
    });
  }

  private takeBullet(at: number): RenderBullet {
    return (this.bulletPool[at] ??= { x: 0, y: 0, bot: false });
  }

  private takeRock(at: number): RenderRock {
    return (this.rockPool[at] ??= { x: 0, y: 0, ang: 0, size: 0, shape: 0 });
  }

  private bracket(): [Buffered, Snapshot, number] {
    const buffer = this.buffer;
    const last = buffer[buffer.length - 1];
    if (buffer.length === 1) return [last, last.snap, 1];

    for (let i = buffer.length - 1; i > 0; i--) {
      const newer = buffer[i].snap;
      const older = buffer[i - 1];
      if (older.snap.tick <= this.playbackTick && this.playbackTick <= newer.tick) {
        const span = newer.tick - older.snap.tick;
        const alpha = span > 0 ? (this.playbackTick - older.snap.tick) / span : 1;
        return [older, newer, alpha];
      }
    }

    const first = buffer[0];
    return this.playbackTick < first.snap.tick
      ? [first, first.snap, 1]
      : [last, last.snap, 1];
  }

  private patch(next: Partial<HudState>): void {
    this.hud = { ...this.hud, ...next };
    for (const listener of this.listeners) listener();
  }
}

export function inputFromKeys(keys: Set<string>): number {
  let bits = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) bits |= INPUT_LEFT;
  if (keys.has("ArrowRight") || keys.has("KeyD")) bits |= INPUT_RIGHT;
  if (keys.has("ArrowUp") || keys.has("KeyW")) bits |= INPUT_THRUST;
  if (keys.has("Space")) bits |= INPUT_FIRE;
  return bits;
}

function restoreSession(): string {
  const key = "bp:session";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

function indexOf(entry: Buffered): SnapshotIndex {
  if (entry.index) return entry.index;
  const index: SnapshotIndex = { ships: new Map(), bullets: new Map(), rocks: new Map() };
  for (const ship of entry.snap.ships) index.ships.set(ship.id, ship);
  for (const bullet of entry.snap.bullets) index.bullets.set(bullet.id, bullet);
  for (const rock of entry.snap.rocks) index.rocks.set(rock.id, rock);
  entry.index = index;
  return index;
}

function lerpWrapped(from: number, to: number, alpha: number, span: number): number {
  return wrap(from + axisDelta(from, to, span) * alpha, span);
}

function lerpAngle(from: number, to: number, alpha: number): number {
  return from + angleDelta(from, to) * alpha;
}

/** Signed distance between two packed angles, in byte steps. */
function shortestByte(from: number, to: number): number {
  let delta = (to - from) % 256;
  if (delta > 128) delta -= 256;
  if (delta < -128) delta += 256;
  return delta;
}

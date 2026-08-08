export const SNAPSHOT_VERSION = 1;

export type ShipWire = {
  id: number;
  x: number;
  y: number;
  ang: number;
  flags: number;
};

export type BulletWire = { id: number; x: number; y: number; flags: number };

export type RockWire = {
  id: number;
  x: number;
  y: number;
  ang: number;
  size: number;
  shape: number;
};

export type EventWire = { type: number; x: number; y: number; mag: number };

export type Snapshot = {
  tick: number;
  ships: ShipWire[];
  bullets: BulletWire[];
  rocks: RockWire[];
  events: EventWire[];
};

const HEADER_BYTES = 12;
const SHIP_BYTES = 8;
const BULLET_BYTES = 7;
const ROCK_BYTES = 8;
const EVENT_BYTES = 6;

const TAU = Math.PI * 2;

export function packAngle(radians: number): number {
  const wrapped = ((radians % TAU) + TAU) % TAU;
  return Math.round((wrapped / TAU) * 256) & 0xff;
}

export function unpackAngle(byte: number): number {
  return (byte / 256) * TAU;
}

export function encodeSnapshot(snap: Snapshot): Uint8Array {
  const events = snap.events.slice(0, 255);
  const size =
    HEADER_BYTES +
    snap.ships.length * SHIP_BYTES +
    snap.bullets.length * BULLET_BYTES +
    snap.rocks.length * ROCK_BYTES +
    events.length * EVENT_BYTES;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);

  view.setUint8(0, SNAPSHOT_VERSION);
  view.setUint32(1, snap.tick >>> 0, true);
  view.setUint16(5, snap.ships.length, true);
  view.setUint16(7, snap.bullets.length, true);
  view.setUint16(9, snap.rocks.length, true);
  view.setUint8(11, events.length);

  let at = HEADER_BYTES;

  for (const ship of snap.ships) {
    view.setUint16(at, ship.id, true);
    view.setUint16(at + 2, clampCoord(ship.x), true);
    view.setUint16(at + 4, clampCoord(ship.y), true);
    view.setUint8(at + 6, ship.ang & 0xff);
    view.setUint8(at + 7, ship.flags & 0xff);
    at += SHIP_BYTES;
  }

  for (const bullet of snap.bullets) {
    view.setUint16(at, bullet.id, true);
    view.setUint16(at + 2, clampCoord(bullet.x), true);
    view.setUint16(at + 4, clampCoord(bullet.y), true);
    view.setUint8(at + 6, bullet.flags & 0xff);
    at += BULLET_BYTES;
  }

  for (const rock of snap.rocks) {
    view.setUint16(at, rock.id, true);
    view.setUint16(at + 2, clampCoord(rock.x), true);
    view.setUint16(at + 4, clampCoord(rock.y), true);
    view.setUint8(at + 6, rock.ang & 0xff);
    view.setUint8(at + 7, ((rock.shape & 0x3f) << 2) | (rock.size & 0x03));
    at += ROCK_BYTES;
  }

  for (const event of events) {
    view.setUint8(at, event.type & 0xff);
    view.setUint16(at + 1, clampCoord(event.x), true);
    view.setUint16(at + 3, clampCoord(event.y), true);
    view.setUint8(at + 5, event.mag & 0xff);
    at += EVENT_BYTES;
  }

  return new Uint8Array(buffer);
}

export function decodeSnapshot(data: ArrayBuffer): Snapshot | null {
  if (data.byteLength < HEADER_BYTES) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== SNAPSHOT_VERSION) return null;

  const tick = view.getUint32(1, true);
  const shipCount = view.getUint16(5, true);
  const bulletCount = view.getUint16(7, true);
  const rockCount = view.getUint16(9, true);
  const eventCount = view.getUint8(11);

  const expected =
    HEADER_BYTES +
    shipCount * SHIP_BYTES +
    bulletCount * BULLET_BYTES +
    rockCount * ROCK_BYTES +
    eventCount * EVENT_BYTES;
  if (data.byteLength < expected) return null;

  const ships: ShipWire[] = [];
  const bullets: BulletWire[] = [];
  const rocks: RockWire[] = [];
  const events: EventWire[] = [];

  let at = HEADER_BYTES;

  for (let i = 0; i < shipCount; i++) {
    ships.push({
      id: view.getUint16(at, true),
      x: view.getUint16(at + 2, true),
      y: view.getUint16(at + 4, true),
      ang: view.getUint8(at + 6),
      flags: view.getUint8(at + 7),
    });
    at += SHIP_BYTES;
  }

  for (let i = 0; i < bulletCount; i++) {
    bullets.push({
      id: view.getUint16(at, true),
      x: view.getUint16(at + 2, true),
      y: view.getUint16(at + 4, true),
      flags: view.getUint8(at + 6),
    });
    at += BULLET_BYTES;
  }

  for (let i = 0; i < rockCount; i++) {
    const meta = view.getUint8(at + 7);
    rocks.push({
      id: view.getUint16(at, true),
      x: view.getUint16(at + 2, true),
      y: view.getUint16(at + 4, true),
      ang: view.getUint8(at + 6),
      size: meta & 0x03,
      shape: (meta >> 2) & 0x3f,
    });
    at += ROCK_BYTES;
  }

  for (let i = 0; i < eventCount; i++) {
    events.push({
      type: view.getUint8(at),
      x: view.getUint16(at + 1, true),
      y: view.getUint16(at + 3, true),
      mag: view.getUint8(at + 5),
    });
    at += EVENT_BYTES;
  }

  return { tick, ships, bullets, rocks, events };
}

function clampCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(65535, Math.round(value)));
}

export type BoardEntry = { name: string; score: number; bot?: boolean };
export type RunEntry = { name: string; score: number; endedAt: string };

export type RosterEntry = {
  id: number;
  name: string;
  bot: boolean;
  score: number;
};

export type ServerMessage =
  | {
      t: "welcome";
      clientId: string;
      pod: string;
      replica: number;
      replicas: number;
      release: string;
      region: string;
      leader: boolean;
    }
  | { t: "roster"; players: RosterEntry[]; humans: number; spectators: number }
  | { t: "board"; live: BoardEntry[]; allTime: RunEntry[]; today: RunEntry[] }
  | { t: "joined"; shipId: number }
  | { t: "queued"; position: number }
  | { t: "rejected"; reason: string }
  | { t: "died"; score: number; asteroids: number; survivedMs: number; by: string }
  | { t: "pong"; c: number }
  | { t: "meta"; replica: number; replicas: number; leader: boolean };

export type ClientMessage =
  | { t: "join"; name: string; session?: string }
  | { t: "leave" }
  | { t: "input"; b: number; a?: number }
  | { t: "ping"; c: number };

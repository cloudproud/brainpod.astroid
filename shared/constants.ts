export const WORLD_W = 1920;
export const WORLD_H = 1200;

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;

/** Clients render this far behind the newest snapshot so interpolation always has two frames to work with. */
export const INTERP_DELAY_MS = 100;
/** Local prediction gives up and teleports once the server disagrees by more than this many world units. */
export const RECONCILE_SNAP = 90;

export const SHIP_RADIUS = 15;
export const SHIP_TURN_RATE = 3.6;
export const SHIP_THRUST = 540;
export const SHIP_DAMPING = 0.55;
export const SHIP_MAX_SPEED = 440;

export const FIRE_COOLDOWN_MS = 200;
export const BULLET_SPEED = 720;
export const BULLET_TTL_MS = 1150;
export const BULLET_RADIUS = 3;

export const RESPAWN_MS = 3000;
export const INVULN_MS = 2000;

/** Cursor closer than this to the ship counts as "here" — aim holds, thrust stops. */
export const AIM_DEADZONE = 45;
/** Below this heading error the ship stops correcting, so it never hunts. */
export const AIM_SETTLED = 0.02;

export const ROCK_RADII = [64, 34, 18] as const;
export const ROCK_SCORES = [20, 50, 100] as const;

export const ROCK_SPEEDS = [
  [26, 62],
  [52, 104],
  [84, 150],
] as const;
/** Large-asteroid equivalents the field is topped back up to. */
export const ROCK_TARGET = 9;

export const MAX_SHIPS = 24;
export const BOT_MIN = 4;
export const BOT_MAX = 6;

/**
 * A room joining from one office wifi shares a public IP, and that room is the
 * whole demo — so the per-IP cap is set to keep any single source from taking
 * the arena rather than to keep it to one player. Tighten both via the
 * environment for a URL that has to survive the open internet unattended.
 */
export const MAX_SHIPS_PER_IP = 12;
export const JOINS_PER_MINUTE = 60;

export const INPUT_LEFT = 1;
export const INPUT_RIGHT = 2;
export const INPUT_THRUST = 4;
export const INPUT_FIRE = 8;
/** Steer toward the angle carried alongside the bits, instead of LEFT/RIGHT. */
export const INPUT_AIM = 16;
export const INPUT_MASK = 31;

export const SHIP_FLAG_THRUST = 1;
export const SHIP_FLAG_INVULN = 2;
export const SHIP_FLAG_BOT = 4;

export const EVENT_ROCK_BURST = 0;
export const EVENT_SHIP_EXPLODE = 1;
export const EVENT_SPARK = 2;
export const EVENT_SPAWN = 3;

export const KEY_LEADER = "bp:sim:leader";
export const KEY_WORLD = "bp:sim:world";
export const CHANNEL_SNAP = "bp:snap";
export const CHANNEL_INPUTS = "bp:inputs";
export const KEY_SCORES_LIVE = "bp:scores:live";
export const KEY_PRESENCE = "bp:presence";
export const KEY_REPLICAS = "bp:replicas";

export const LEASE_MS = 1500;
export const LEASE_RENEW_MS = 500;
export const WORLD_PERSIST_MS = 500;
/** A resumed world older than this is stale enough that a fresh field looks better than a rewind. */
export const WORLD_MAX_AGE_MS = 15000;

export const PRESENCE_TTL_MS = 6000;
export const REPLICA_TTL_MS = 6000;

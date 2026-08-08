import { randomUUID } from "crypto";
import type { Duplex } from "stream";
import type { IncomingMessage } from "http";
import { WebSocket, WebSocketServer } from "ws";
import {
  CHANNEL_INPUTS,
  CHANNEL_SNAP,
  KEY_PRESENCE,
  KEY_REPLICAS,
  KEY_SCORES_LIVE,
  INPUT_MASK,
  KEY_WORLD,
  PRESENCE_TTL_MS,
  REPLICA_TTL_MS,
  SNAPSHOT_MS,
  TICK_MS,
  WORLD_MAX_AGE_MS,
  WORLD_PERSIST_MS,
} from "../shared/constants";
import { sanitizeName } from "../shared/names";
import {
  encodeSnapshot,
  unpackAngle,
  type BoardEntry,
  type RosterEntry,
  type RunEntry,
  type ServerMessage,
} from "../shared/protocol";
import { BotDirector } from "./bots";
import { Database } from "./db";
import { env } from "./env";
import { LeaderLease } from "./leader";
import { log } from "./log";
import { createRedis, defineLeaseCommands, type LeaseRedis } from "./redis";
import { Sim, type DeathReport } from "./sim";

const CHANNEL_STATE = "bp:state";
const STATE_MS = 250;
const INPUT_FLUSH_MS = 25;
const SOCKET_BACKPRESSURE = 512 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Control =
  | { t: "join"; playerId: string; name: string }
  | { t: "leave"; playerId: string }
  | { t: "input"; playerId: string; b: number; a?: number };

type StatePlayer = {
  playerId: string;
  id: number;
  name: string;
  bot: boolean;
  score: number;
  alive: boolean;
};

type StateMessage = {
  players: StatePlayer[];
  deaths: DeathReport[];
};

type Client = {
  playerId: string;
  socket: WebSocket;
  ip: string;
  name: string | null;
  shipId: number | null;
  wantsShip: boolean;
  announced: boolean;
  lastJoinAttempt: number;
  input: number;
  aim: number | null;
  alive: boolean;
};

export class Runtime {
  private readonly commands: LeaseRedis;
  private readonly subscriber: LeaseRedis;
  private readonly publisher: LeaseRedis;
  private readonly db = new Database();
  private readonly lease: LeaderLease;
  private readonly clients = new Set<Client>();
  private readonly bots = new BotDirector();
  private wss: WebSocketServer | null = null;

  private sim: Sim | null = null;
  private simTimer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastStepAt = 0;
  private outbox: Control[] = [];
  private pendingDeaths: DeathReport[] = [];
  private intervals: NodeJS.Timeout[] = [];
  private leaderIntervals: NodeJS.Timeout[] = [];

  private replicaIndex = 1;
  private replicaCount = 1;
  private liveBoard: BoardEntry[] = [];
  private allTimeBoard: RunEntry[] = [];
  private todayBoard: RunEntry[] = [];
  private roster: RosterEntry[] = [];
  private humans = 0;
  private spectators = 0;
  private shuttingDown = false;

  constructor() {
    this.commands = createRedis("commands") as LeaseRedis;
    this.subscriber = createRedis("subscriber") as LeaseRedis;
    this.publisher = createRedis("publisher") as LeaseRedis;
    defineLeaseCommands(this.commands);

    this.lease = new LeaderLease(this.commands, env.podId, {
      onAcquire: () => this.becomeLeader(),
      onLose: () => this.stepDown(),
    });
  }

  get isLeader(): boolean {
    return this.lease.isLeader;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(migrationsDir: string): Promise<void> {
    await this.db.migrate(migrationsDir);
    await this.subscribe();

    this.lease.start();

    this.intervals.push(
      setInterval(() => this.flushInputs(), INPUT_FLUSH_MS),
      setInterval(() => void this.heartbeatReplica(), 2000),
      setInterval(() => void this.refreshLiveBoard(), 1000),
      setInterval(() => void this.refreshRunBoards(), 5000),
      setInterval(() => void this.heartbeatPresence(), 2000),
      setInterval(() => this.broadcast(this.boardMessage()), 1000),
      setInterval(() => this.retryQueuedJoins(), 1500),
      setInterval(() => this.pingSockets(), 30000),
    );

    void this.heartbeatReplica();
    void this.refreshLiveBoard();
    void this.refreshRunBoards();
  }

  attach(): void {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.wss = wss;

    wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      this.onConnection(socket, request);
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss || this.shuttingDown) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }

  private async subscribe(): Promise<void> {
    await this.subscriber.subscribe(CHANNEL_SNAP, CHANNEL_STATE, CHANNEL_INPUTS);

    this.subscriber.on("messageBuffer", (channel: Buffer, payload: Buffer) => {
      const name = channel.toString();
      if (name === CHANNEL_SNAP) {
        this.fanOutSnapshot(payload);
        return;
      }
      if (name === CHANNEL_STATE) {
        this.onState(payload.toString());
        return;
      }
      if (name === CHANNEL_INPUTS && this.sim) {
        this.onControl(payload.toString());
      }
    });
  }

  private async becomeLeader(): Promise<void> {
    const saved = await this.commands.get(KEY_WORLD).catch(() => null);
    const world = saved ? Sim.deserialize(saved) : null;
    const fresh = !world || Date.now() - world.savedAt > WORLD_MAX_AGE_MS;

    this.sim = new Sim(fresh ? undefined : world!);
    log.info(fresh ? "simulation started from a fresh world" : "simulation resumed", {
      ships: this.sim.world.ships.length,
      rocks: this.sim.world.rocks.length,
    });

    this.accumulator = 0;
    this.lastStepAt = Date.now();
    this.simTimer = setInterval(() => this.stepSimulation(), 8);
    this.leaderIntervals.push(
      setInterval(() => this.publishSnapshot(), SNAPSHOT_MS),
      setInterval(() => this.publishState(), STATE_MS),
      setInterval(() => void this.persistWorld(), WORLD_PERSIST_MS),
      setInterval(() => void this.publishScores(), 1000),
      setInterval(() => void this.prunePresence(), 1000),
    );
  }

  /**
   * A lease can be lost and won again, so the publishers the leader started have
   * to go with it. Leaving them running would double the snapshot rate for every
   * client on the next term.
   */
  private async stepDown(): Promise<void> {
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;
    for (const timer of this.leaderIntervals) clearInterval(timer);
    this.leaderIntervals = [];
    this.sim = null;
  }

  private stepSimulation(): void {
    const sim = this.sim;
    if (!sim) return;

    const now = Date.now();
    const elapsed = Math.min(now - this.lastStepAt, 250);
    this.lastStepAt = now;
    this.accumulator += elapsed;

    while (this.accumulator >= TICK_MS) {
      this.bots.update(sim, now);
      sim.step(TICK_MS / 1000, now);
      this.accumulator -= TICK_MS;
    }

    const deaths = sim.takeDeaths();
    if (deaths.length) this.onDeaths(deaths);
  }

  private onDeaths(deaths: DeathReport[]): void {
    this.pendingDeaths.push(...deaths);
    for (const death of deaths) {
      void this.db
        .recordRun({
          playerName: death.name,
          score: death.score,
          kills: death.kills,
          asteroids: death.asteroids,
          survivedMs: death.survivedMs,
          isBot: death.bot,
        })
        .catch((error: Error) =>
          log.error("failed to record run", { message: error.message }),
        );
    }
  }

  private publishSnapshot(): void {
    if (!this.sim) return;
    const payload = encodeSnapshot(this.sim.snapshot());
    void this.publisher.publish(CHANNEL_SNAP, Buffer.from(payload));
  }

  private publishState(): void {
    const sim = this.sim;
    if (!sim) return;

    const message: StateMessage = {
      players: sim.world.ships.map((ship) => ({
        playerId: ship.playerId,
        id: ship.id,
        name: ship.name,
        bot: ship.bot,
        score: ship.score,
        alive: ship.alive,
      })),
      deaths: this.pendingDeaths.splice(0, this.pendingDeaths.length),
    };

    void this.publisher.publish(CHANNEL_STATE, JSON.stringify(message));
  }

  private async persistWorld(): Promise<void> {
    if (!this.sim) return;
    await this.commands.set(KEY_WORLD, this.sim.serialize(), "EX", 60).catch(() => {});
  }

  private async publishScores(): Promise<void> {
    const sim = this.sim;
    if (!sim) return;

    const pipeline = this.commands.multi();
    pipeline.del(KEY_SCORES_LIVE);
    for (const ship of sim.world.ships) {
      if (!ship.alive) continue;
      pipeline.zadd(
        KEY_SCORES_LIVE,
        ship.score,
        `${ship.bot ? "1" : "0"}:${ship.id}:${ship.name}`,
      );
    }
    await pipeline.exec().catch(() => {});
  }

  private async prunePresence(): Promise<void> {
    const sim = this.sim;
    if (!sim) return;

    const cutoff = Date.now() - PRESENCE_TTL_MS;
    await this.commands.zremrangebyscore(KEY_PRESENCE, "-inf", cutoff).catch(() => {});
    const present = new Set(await this.commands.zrange(KEY_PRESENCE, 0, -1).catch(() => []));

    for (const ship of [...sim.world.ships]) {
      if (ship.bot) continue;
      if (!present.has(ship.playerId)) sim.removeShip(ship.playerId);
    }
  }

  private onControl(raw: string): void {
    const sim = this.sim;
    if (!sim) return;

    let batch: Control[];
    try {
      batch = JSON.parse(raw) as Control[];
    } catch {
      return;
    }
    if (!Array.isArray(batch)) return;

    for (const control of batch) {
      if (!control || typeof control.playerId !== "string") continue;
      if (control.t === "join") {
        sim.addShip({
          playerId: control.playerId,
          name: sanitizeName(control.name),
          bot: false,
        });
      } else if (control.t === "leave") {
        sim.removeShip(control.playerId);
      } else if (control.t === "input") {
        const aim = typeof control.a === "number" ? unpackAngle(control.a) : null;
        sim.setInput(control.playerId, Number(control.b) | 0, aim);
      }
    }
  }

  private onState(raw: string): void {
    let state: StateMessage;
    try {
      state = JSON.parse(raw) as StateMessage;
    } catch {
      return;
    }

    const byPlayer = new Map(state.players.map((player) => [player.playerId, player]));

    this.roster = state.players.map((player) => ({
      id: player.id,
      name: player.name,
      bot: player.bot,
      score: player.score,
    }));
    this.humans = state.players.reduce((total, p) => total + (p.bot ? 0 : 1), 0);

    let spectators = 0;
    for (const client of this.clients) {
      const player = byPlayer.get(client.playerId);
      if (player) {
        client.shipId = player.id;
        if (!client.announced) {
          client.announced = true;
          this.send(client, { t: "joined", shipId: player.id });
        }
      } else {
        client.shipId = null;
        client.announced = false;
        if (client.wantsShip) spectators++;
      }
    }
    this.spectators = spectators;

    for (const death of state.deaths) {
      const client = this.findClient(death.playerId);
      if (!client) continue;
      this.send(client, {
        t: "died",
        score: death.score,
        asteroids: death.asteroids,
        survivedMs: death.survivedMs,
        by: death.by,
      });
    }

    this.broadcast(this.rosterMessage());
  }

  private fanOutSnapshot(payload: Buffer): void {
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.socket.bufferedAmount > SOCKET_BACKPRESSURE) continue;
      client.socket.send(payload, { binary: true });
    }
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const client: Client = {
      playerId: randomUUID(),
      socket,
      ip: clientIp(request),
      name: null,
      shipId: null,
      wantsShip: false,
      announced: false,
      lastJoinAttempt: 0,
      input: 0,
      aim: null,
      alive: true,
    };
    this.clients.add(client);

    this.send(client, {
      t: "welcome",
      clientId: client.playerId,
      pod: env.podId,
      replica: this.replicaIndex,
      replicas: this.replicaCount,
      release: env.release,
      region: env.region,
      leader: this.isLeader,
    });
    this.send(client, this.rosterMessage());
    this.send(client, this.boardMessage());

    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      void this.onClientMessage(client, data.toString());
    });

    // A dropped socket is not a departure: presence carries its own TTL, which
    // doubles as the grace window a reconnecting player needs to keep their ship.
    socket.on("close", () => this.clients.delete(client));

    socket.on("error", () => socket.terminate());
  }

  private async onClientMessage(client: Client, raw: string): Promise<void> {
    if (raw.length > 512) return;

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    const kind = (message as { t?: unknown }).t;

    if (kind === "ping") {
      const stamp = Number((message as { c?: unknown }).c);
      if (Number.isFinite(stamp)) this.send(client, { t: "pong", c: stamp });
      return;
    }

    if (kind === "input") {
      const bits = Number((message as { b?: unknown }).b);
      if (!Number.isInteger(bits) || bits < 0 || bits > INPUT_MASK) return;

      const rawAim = (message as { a?: unknown }).a;
      const aim =
        Number.isInteger(rawAim) && (rawAim as number) >= 0 && (rawAim as number) < 256
          ? (rawAim as number)
          : null;

      if (!client.wantsShip) return;
      if (bits === client.input && aim === client.aim) return;
      client.input = bits;
      client.aim = aim;
      this.outbox.push({
        t: "input",
        playerId: client.playerId,
        b: bits,
        ...(aim === null ? {} : { a: aim }),
      });
      return;
    }

    if (kind === "leave") {
      if (!client.wantsShip) return;
      client.wantsShip = false;
      client.announced = false;
      this.outbox.push({ t: "leave", playerId: client.playerId });
      await this.commands.zrem(KEY_PRESENCE, client.playerId).catch(() => {});
      await this.commands.zrem(`bp:ip:${client.ip}`, client.playerId).catch(() => {});
      return;
    }

    if (kind === "join") {
      if (client.wantsShip) return;
      const name = sanitizeName((message as { name?: unknown }).name);

      // The browser keeps this id for the tab's lifetime, so a socket that dies
      // with a draining replica re-enters the same ship with the same score
      // instead of respawning as a stranger.
      const session = (message as { session?: unknown }).session;
      if (typeof session === "string" && SESSION_ID.test(session)) {
        client.playerId = session;
      }

      const refusal = await this.refuseJoin(client);
      if (refusal) {
        this.send(client, { t: "rejected", reason: refusal });
        return;
      }

      client.name = name;
      client.wantsShip = true;
      client.lastJoinAttempt = Date.now();
      await this.markPresence(client);
      this.outbox.push({ t: "join", playerId: client.playerId, name });
    }
  }

  /** Returns a message to show the player, or null when they may fly. */
  private async refuseJoin(client: Client): Promise<string | null> {
    const rateKey = `bp:rl:${client.ip}`;
    const attempts = await this.commands.incr(rateKey).catch(() => 0);
    if (attempts === 1) await this.commands.expire(rateKey, 60).catch(() => {});
    if (attempts > env.joinsPerMinute) {
      return "Too many joins from this network — try again in a minute.";
    }

    const ipKey = `bp:ip:${client.ip}`;
    const now = Date.now();
    await this.commands.zremrangebyscore(ipKey, "-inf", now - PRESENCE_TTL_MS).catch(() => {});
    const concurrent = await this.commands.zcard(ipKey).catch(() => 0);
    if (concurrent >= env.maxShipsPerIp) {
      return `This network already has ${env.maxShipsPerIp} ships in the arena. Close one, or watch instead.`;
    }

    return null;
  }

  private async markPresence(client: Client): Promise<void> {
    const now = Date.now();
    await this.commands.zadd(KEY_PRESENCE, now, client.playerId).catch(() => {});
    const ipKey = `bp:ip:${client.ip}`;
    await this.commands.zadd(ipKey, now, client.playerId).catch(() => {});
    await this.commands.expire(ipKey, 120).catch(() => {});
  }

  private async heartbeatPresence(): Promise<void> {
    const active = [...this.clients].filter((client) => client.wantsShip);
    if (!active.length) return;

    const now = Date.now();
    const pipeline = this.commands.multi();
    for (const client of active) {
      pipeline.zadd(KEY_PRESENCE, now, client.playerId);
      pipeline.zadd(`bp:ip:${client.ip}`, now, client.playerId);
      pipeline.expire(`bp:ip:${client.ip}`, 120);
    }
    await pipeline.exec().catch(() => {});
  }

  private retryQueuedJoins(): void {
    const now = Date.now();
    for (const client of this.clients) {
      if (!client.wantsShip || client.shipId !== null) continue;
      if (now - client.lastJoinAttempt < 2000) continue;
      client.lastJoinAttempt = now;
      this.outbox.push({
        t: "join",
        playerId: client.playerId,
        name: client.name ?? "PILOT",
      });
      this.send(client, { t: "queued", position: this.spectators });
    }
  }

  private flushInputs(): void {
    if (!this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];
    void this.publisher.publish(CHANNEL_INPUTS, JSON.stringify(batch));
  }

  private async heartbeatReplica(): Promise<void> {
    const now = Date.now();
    try {
      await this.commands.zadd(KEY_REPLICAS, now, env.podId);
      await this.commands.zremrangebyscore(KEY_REPLICAS, "-inf", now - REPLICA_TTL_MS);
      const members = await this.commands.zrange(KEY_REPLICAS, 0, -1);
      const sorted = [...members].sort();
      const index = sorted.indexOf(env.podId);
      const replicaIndex = index >= 0 ? index + 1 : 1;
      const replicaCount = Math.max(sorted.length, 1);

      if (replicaIndex !== this.replicaIndex || replicaCount !== this.replicaCount) {
        this.replicaIndex = replicaIndex;
        this.replicaCount = replicaCount;
        this.broadcast({
          t: "meta",
          replica: replicaIndex,
          replicas: replicaCount,
          leader: this.isLeader,
        });
      }
    } catch (error) {
      log.error("replica heartbeat failed", { message: (error as Error).message });
    }
  }

  private async refreshLiveBoard(): Promise<void> {
    try {
      const raw = await this.commands.zrevrange(KEY_SCORES_LIVE, 0, 9, "WITHSCORES");
      const entries: BoardEntry[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const member = raw[i];
        const separator = member.indexOf(":", 2);
        entries.push({
          name: member.slice(separator + 1),
          score: Number(raw[i + 1]) || 0,
          bot: member.startsWith("1:"),
        });
      }
      this.liveBoard = entries;
    } catch {
      /* a board that is briefly stale is better than a dropped frame */
    }
  }

  private async refreshRunBoards(): Promise<void> {
    try {
      const [allTime, today] = await Promise.all([
        this.db.topAllTime(10),
        this.db.topToday(10),
      ]);
      this.allTimeBoard = allTime;
      this.todayBoard = today;
    } catch (error) {
      log.error("failed to refresh run boards", { message: (error as Error).message });
    }
  }

  private boardMessage(): ServerMessage {
    return {
      t: "board",
      live: this.liveBoard,
      allTime: this.allTimeBoard,
      today: this.todayBoard,
    };
  }

  private rosterMessage(): ServerMessage {
    return {
      t: "roster",
      players: this.roster,
      humans: this.humans,
      spectators: this.spectators,
    };
  }

  private pingSockets(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  private findClient(playerId: string): Client | undefined {
    for (const client of this.clients) {
      if (client.playerId === playerId) return client;
    }
    return undefined;
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  }

  /** One serialization for the whole room, not one per socket. */
  private broadcast(message: ServerMessage): void {
    if (!this.clients.size) return;
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  /**
   * The handoff a rolling deploy depends on: flush the world and drop the lease
   * before the process goes away, so a successor resumes from the same tick
   * rather than rebuilding an empty arena 1.5 seconds later.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.intervals) clearInterval(timer);
    for (const timer of this.leaderIntervals) clearInterval(timer);
    this.intervals = [];
    this.leaderIntervals = [];

    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;

    if (this.sim) {
      await this.persistWorld();
      this.sim = null;
    }
    await this.lease.stop();

    for (const client of this.clients) {
      client.socket.close(1012, "replica restarting");
    }
    this.wss?.close();

    await this.commands.zrem(KEY_REPLICAS, env.podId).catch(() => {});
    await Promise.all([
      this.db.close(),
      this.commands.quit().catch(() => {}),
      this.subscriber.quit().catch(() => {}),
      this.publisher.quit().catch(() => {}),
    ]);
  }
}

function clientIp(request: IncomingMessage): string {
  if (env.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

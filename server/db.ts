import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { env } from "./env";
import { log } from "./log";
import type { RunEntry } from "../shared/protocol";

/** Any replica may boot first, so migrations run under a lock all of them contend for. */
const MIGRATION_LOCK = 8123471;

export type RunRecord = {
  playerName: string;
  score: number;
  kills: number;
  asteroids: number;
  survivedMs: number;
  isBot: boolean;
};

export class Database {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: env.databaseUrl,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on("error", (error) =>
      log.error("postgres pool error", { message: error.message }),
    );
  }

  async migrate(directory: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      await client.query(
        `create table if not exists schema_migrations (
           name text primary key,
           applied_at timestamptz not null default now()
         )`,
      );

      const applied = new Set(
        (await client.query<{ name: string }>("select name from schema_migrations")).rows.map(
          (row) => row.name,
        ),
      );

      const files = readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(directory, file), "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query("insert into schema_migrations (name) values ($1)", [file]);
          await client.query("commit");
          log.info("migration applied", { file });
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
      client.release();
    }
  }

  async recordRun(run: RunRecord): Promise<void> {
    await this.pool.query(
      `insert into runs (player_name, score, kills, asteroids, survived_ms, region, is_bot)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        run.playerName,
        run.score,
        run.kills,
        run.asteroids,
        Math.min(run.survivedMs, 2_147_483_647),
        env.region,
        run.isBot,
      ],
    );
  }

  async topAllTime(limit = 10): Promise<RunEntry[]> {
    const result = await this.pool.query<{
      player_name: string;
      score: number;
      ended_at: Date;
    }>(
      `select player_name, score, ended_at
         from runs
        where not is_bot
        order by score desc, ended_at asc
        limit $1`,
      [limit],
    );
    return result.rows.map(toRunEntry);
  }

  async topToday(limit = 10): Promise<RunEntry[]> {
    const result = await this.pool.query<{
      player_name: string;
      score: number;
      ended_at: Date;
    }>(
      `select player_name, score, ended_at
         from runs
        where not is_bot
          and ended_at >= date_trunc('day', now())
        order by score desc, ended_at asc
        limit $1`,
      [limit],
    );
    return result.rows.map(toRunEntry);
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

function toRunEntry(row: {
  player_name: string;
  score: number;
  ended_at: Date;
}): RunEntry {
  return {
    name: row.player_name,
    score: row.score,
    endedAt: row.ended_at.toISOString(),
  };
}

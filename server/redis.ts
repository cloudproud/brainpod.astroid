import Redis from "ioredis";
import { env } from "./env";
import { log } from "./log";

export function createRedis(role: string): Redis {
  const client = new Redis(env.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableAutoPipelining: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });

  client.on("error", (error: Error) => {
    log.error("redis error", { role, message: error.message });
  });

  return client;
}

const RENEW_LEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export function defineLeaseCommands(client: Redis) {
  client.defineCommand("renewLease", {
    numberOfKeys: 1,
    lua: RENEW_LEASE,
  });
  client.defineCommand("releaseLease", {
    numberOfKeys: 1,
    lua: RELEASE_LEASE,
  });
}

export type LeaseRedis = Redis & {
  renewLease(key: string, owner: string, ttlMs: number): Promise<number>;
  releaseLease(key: string, owner: string): Promise<number>;
};

# Deploying this project

Facts a deploy agent would otherwise have to derive from the source. They are
checked against the code, not aspirational — if one of them stops being true,
fix it here in the same change.

## Build

A `Dockerfile` sits at the context root, so `brainpod image build` uses it and
Railpack never runs. Nothing needs to be passed to the build: `RELEASE_ID` is a
build arg only so the local compose cluster can stamp an image, and the running
container reads it from the environment instead.

The compile stages are pinned to `$BUILDPLATFORM` because `next build` and `tsc`
emit platform-independent JavaScript. Only the runtime dependency install and
the final image target the cluster architecture. Do not pass `--platform` to
override this — the split is what keeps the build off the emulator on an ARM
host, and the CLI already resolves the target from the active clusters.

## Runtime shape

- Listens on `PORT`, defaulting to 3000. The Dockerfile already sets it, so the
  Route rule can target 3000 without adding an env var.
- Runs as uid 1000 and writes nothing to disk. The app needs no `Disk` and no
  mounts; the databases need their own.
- Readiness is `GET /healthz`, which returns 200 and a JSON body naming the pod,
  release, region, leadership, and connected client count.
- WebSockets are served at `/ws`. The route has to pass upgrades through.
- `replicas` may be anything from 1 to 10. Exactly one replica wins a Valkey
  lease and runs the simulation; the rest are gateways. Scaling either way is
  safe at any time.

## Resources

`App` + `Route` + `Postgres` (version 16) + `Valkey` (version 9), and a `Disk`
for each of the two databases. The docs call the first one PostgresDB; the
resource kind the CLI validates against is `Postgres`.

The App runs at `1x`. Anything smaller is capped at a single replica, which
would take the leader-and-gateways split with it; `.5x` is fine for both
databases.

The App itself takes no `Disk` and no mounts. That is a requirement rather than
an omission: an app with a disk mount is capped at a single instance, which
would take the multi-replica behaviour this project exists to show with it.

Schema migrations live in `migrations/` and are applied at boot under a Postgres
advisory lock, so every replica may start at once and no init step, job, or
`lifecycle.init` is needed.

## Environment

Required, both read at boot. Databases export their connection details as
variables an App's environment can reference, so use those rather than
assembling a URL by hand:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${<postgres-name>.uri}` |
| `REDIS_URL` | `${<valkey-name>.uri}` |

Postgres also exports `.host`, `.port`, `.user`, `.database`, and `.password`;
Valkey exports `.host`, `.port`, and `.password`. Both `uri` forms are TLS —
`postgres://...?sslmode=require` and `rediss://...`.

Everything else has a working default and only needs setting to change it:
`REGION` (`eu-west-1`, shown in the corner badge), `RELEASE_ID`, `TRUST_PROXY`
(`1`; set `0` only with nothing trustworthy setting `X-Forwarded-For` in front),
`MAX_SHIPS_PER_IP`, and `JOINS_PER_MINUTE`. `POD_ID` defaults to the container
hostname, which is already unique per replica.

## Verifying a deploy

`/healthz` answering 200 means the process is up, not that the game works. The
arena is live once one replica reports `"leader": true` and the root page serves
200. Bots join on their own, so a working deploy starts writing `runs` rows
within a minute without anyone playing.

Those rows are not visible on any board. ALL-TIME and TODAY both select
`where not is_bot`, so both stay empty until a human has played and died — an
empty board is not a broken database. What does prove the stack from a terminal:
open a WebSocket to `/ws`, which confirms the Route passes upgrades, then read
the `board` message for a non-empty `live` array (Valkey sorted set) and count
the binary frames arriving at 20 Hz (`bp:snap` fan-out). Postgres is already
proven by the process reaching ready at all, since the boot migration throws on
a failed connection.

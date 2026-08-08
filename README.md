<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/brainpod-wordmark.svg">
  <img src=".github/brainpod-wordmark-light.svg" alt="Brainpod" width="160">
</picture>

# Asteroids

**A public multiplayer Asteroids arena, and a live demo of [Brainpod](https://brainpod.io).**
No signup, no cookie banner — open the link, type a callsign, fly. One Next.js
service, one managed Postgres, one managed Valkey, in `eu-west-1` (Ede, the
Netherlands).

The point of the demo is the part you cannot see: while everyone in the room is
flying, you redeploy the app and nobody's ship stops moving.

![Brainpod Asteroids](docs/screenshot.png)

## Deploy it yourself

You do not need to know anything about this repository. Clone it, open your
coding agent in it, and paste:

```
Install the Brainpod skill from github.com/brainpodnl/skills and use it to deploy my project to Brainpod.

Sign me up using the Brainpod skills, work out what the project needs, and hand me the live URL when it's up.
```

The skill signs you up, reads the project, works out the resource graph — an app
with a route, managed Postgres, managed Valkey — provisions it, and hands back a
live URL. That is the whole onboarding story, and it is worth doing on the call
rather than describing.

<details>
<summary>What the skill ends up creating, if you want to check its work</summary>

An `App` with a `Route`, a `postgres` resource with a `Disk`, and a `valkey`
resource with a `Disk`. The app reads `DATABASE_URL` and `REDIS_URL` from
`App.spec.env`; `RELEASE_ID` belongs there too, so the corner badge changes
visibly on redeploy. Replicas scale to 20 — the leader lease means extra
replicas cost nothing but bandwidth.

The Dockerfile already declares a non-root `USER 1000` and binds `PORT` above
1024, both of which Brainpod enforces at resource creation.

</details>

## What it proves

| Brainpod claim | What demonstrates it |
|---|---|
| **Managed Postgres** | Every finished run writes one `runs` row. Six bots plus a room full of people keep that at ten to twenty inserts a minute unattended, so the database metrics graph is worth opening live. The ALL-TIME board reads straight from it. |
| **Managed Valkey** | The entire multiplayer layer: a lease elects the single authoritative simulation, `bp:snap` fans binary snapshots to every replica at 20 Hz, and the LIVE board is a sorted set. |
| **Up to 20 replicas** | Every replica runs the same image. One wins the lease and simulates; the rest are WebSocket gateways. Scale up mid-call and watch the `replica N of M` badge move. |
| **Zero-downtime deploys** | A draining leader flushes the world to Valkey and releases its lease, so a successor resumes the same tick. Worst measured snapshot gap on the two-replica cluster: **55 ms**, against a 50 ms nominal interval. |
| **EU hosting** | The badge names the region and your RTT. Player names are the only user input, and they never leave `eu-west-1`. |
| **Per-second billing** | A 30 Hz simulation on one small instance, plus gateways that do nothing but fan out bytes. The demo costs what it uses. |

## Architecture

```mermaid
flowchart LR
    subgraph browsers["Browsers"]
        direction TB
        P1["player"]
        P2["player"]
        S1["spectator"]
    end

    subgraph replicas["Replicas — one image, up to 20"]
        direction TB
        R1["replica 1<br/>gateway + LEADER<br/>30 Hz simulation"]
        R2["replica 2<br/>gateway"]
        RN["replica N<br/>gateway"]
    end

    V[("Valkey<br/>hot state")]
    PG[("Postgres<br/>durable truth")]

    P1 -->|WebSocket| R1
    P2 -->|WebSocket| R2
    S1 -->|WebSocket| RN

    R1 <-->|"lease · world · inputs"| V
    R2 <-->|"snapshots 20 Hz"| V
    RN <-->|"snapshots 20 Hz"| V

    R1 -->|"one INSERT per finished run"| PG
```

**Hot state lives in Valkey, durable truth lives in Postgres.** Nothing about a
ship in flight is ever written to Postgres, and nothing on the all-time board is
ever served from Valkey.

Clients send inputs only — turn, thrust, fire, a desired heading — never
positions, so the simulation stays authoritative and cheating is limited by
construction. Each client renders ~100 ms behind the newest snapshot with
interpolation and dead-reckons its own ship locally, so steering feels instant;
it snaps only when the server disagrees by more than 90 world units.

### Why nobody's ship stops during a deploy

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as Replica A (leader)
    participant V as Valkey
    participant C as Replica C (gateway)

    Note over A: rolling deploy drains replica A
    A->>V: flush world to bp:sim:world
    A->>V: release bp:sim:leader
    C->>V: SET NX PX 1500 bp:sim:leader
    V-->>C: lease acquired
    C->>V: read bp:sim:world
    Note over C: simulation resumes on the same tick
    C->>V: publish bp:snap at 20 Hz
    B->>C: reconnect with session id
    C-->>B: same ship, same score
```

Players attached to the drained replica lose their socket and reconnect in about
**half a second**, keeping their ship and score, because the browser holds a
session id and presence has a grace window.

<details>
<summary>The Valkey keyspace</summary>

| Key | Type | Purpose |
|---|---|---|
| `bp:sim:leader` | string | Leader lease, `SET NX PX 1500`, renewed every 500 ms by a Lua compare-and-set |
| `bp:sim:world` | string | Serialized world, written every 500 ms and on `SIGTERM`, so a successor resumes |
| `bp:snap` | pub/sub | Binary snapshots at 20 Hz, ~8 bytes per entity |
| `bp:inputs` | pub/sub | Batched player inputs travelling to the leader |
| `bp:state` | pub/sub | Roster and hit reports, 4 Hz, so gateways can address their own clients |
| `bp:scores:live` | zset | LIVE board — the current run only, reset to zero on death |
| `bp:presence` | zset | `playerId → last seen`; the leader prunes ships whose gateway went away |
| `bp:replicas` | zset | `podId → heartbeat`, behind the `replica N of M` badge |
| `bp:rl:<ip>` | string | Join rate limit, `INCR` + `EXPIRE` |
| `bp:ip:<ip>` | zset | Concurrent ships per IP, enforced across replicas |

</details>

## Running the demo on a call

1. **Before the call**, open the URL once so the arena is warm. Six bots are
   always flying, so it is never an empty screen.
2. **Share a QR code** to the URL. People join from their phones in about five
   seconds — one text field, one button, on-screen thrust and fire controls.
3. **Let it get loud.** Everyone is in the same arena, and nobody sent a position
   to anybody: the ships they see are one authoritative simulation on one
   replica, fanned out through Valkey.
4. **Point at the two boards.** LIVE tracks the run you are in and resets when you
   die, because it is a Valkey sorted set. ALL-TIME does not, because every
   finished run is a row in managed Postgres. Open the Postgres metrics in the
   console while the room plays — the write rate is the room.
5. **Redeploy while they fly.** Change something visible, push, let the rolling
   deploy run. The release id in the corner badge changes and the replica count
   moves. Nobody's ship stops. That is the whole pitch, and they are holding the
   proof.
6. **If someone asks about scale**, raise the replica count live. The badge
   updates within two seconds, and the simulation never moves unless the replica
   running it goes away.

<img src="docs/screenshot-mobile.png" alt="Brainpod Asteroids on a phone" width="240">

## Local development

```bash
docker compose up -d
```

```bash
cp .env.example .env && npm install && npm run dev
```

The app is on http://localhost:3000. Migrations in `migrations/` are applied on
boot behind a Postgres advisory lock, so it does not matter which replica starts
first.

### Two replicas behind a load balancer

The `cluster` profile builds the production image and runs two replicas behind
Caddy, which is the setup the interesting behaviour needs:

```bash
docker compose --profile cluster up --build
```

Open http://localhost:3000, start flying, then take the simulation leader away:

```bash
docker compose stop app-a
```

Your ship keeps moving. `docker compose logs app-b` shows
`acquired simulation lease` followed by `simulation resumed`, with the ship and
asteroid counts carried over. `docker compose start app-a` brings it back as a
gateway.

To watch a redeploy rather than a failure, rebuild one replica at a time — which
is what a Brainpod rolling deploy does:

```bash
RELEASE_ID=v2 docker compose --profile cluster up -d --build --no-deps app-a
```

Set `EDGE_PORT=8080` if port 3000 is taken.

`GET /healthz` reports leader status and connected clients, which is also what
Caddy and Brainpod use to decide whether a replica should get traffic:

```json
{ "status": "ok", "pod": "pod-a", "release": "9f2c1a", "region": "eu-west-1",
  "leader": true, "clients": 12, "uptimeSeconds": 431 }
```

<details>
<summary>The game itself</summary>

Classic vector Asteroids: thrust, rotate, friction, screen wrap, bullets with a
TTL, asteroids splitting large → 2 medium → 2 small. Large asteroids are 20
points, medium 50, small 100.

**One hit ends the run.** Touch an asteroid and it is over: the score becomes a
row in Postgres, and 3 seconds later you are back from zero with 2 seconds of
blinking invulnerability. Nothing to spend and nothing to nurse, which is what
makes the live board tense and the all-time board worth chasing.

**No player-versus-player.** Bullets pass straight through ships. Everyone is
racing the same asteroid field and each other's numbers — the right shape for a
room of people who met the game ten seconds ago.

The arena caps at 24 ships; anyone over the cap watches and is flown in
automatically the moment a slot frees. Bots are named after moons and
observatories, labelled `BOT` everywhere they appear, and shoot deliberately
badly enough that a decent human run tops the live board.

|  | Steer | Fire |
|---|---|---|
| **Mouse** | The ship flies toward your cursor | Click |
| **Keyboard** | Arrow keys or WASD | Space |
| **Touch** | Hold and drag anywhere on the field | The button, bottom right |

The two steering modes coexist: the cursor flies the ship until you touch an
arrow key, and the keys hand back the moment you let go.

</details>

<details>
<summary>Abuse resistance</summary>

The URL is public, so: names are passed through a Unicode allow-list (letters,
digits and a little punctuation — control characters, zero-width joiners and
combining marks are dropped rather than escaped), capped at 16 characters, and
checked against a profanity list; joins are rate-limited per IP through Valkey;
concurrent ships per IP are capped across all replicas; and every inbound message
is shape-validated before it reaches the simulation.

</details>

<details>
<summary>Repository layout, and why there is a custom server</summary>

```
app/          Next.js App Router shell — one page, the game is a client component
components/   HUD, menu, leaderboard, touch controls
lib/          Client netcode (net.ts) and the canvas renderer (render.ts)
shared/       Binary snapshot protocol, constants and name sanitising
server/       Custom server, leader lease, simulation, bots, gateway, Postgres
migrations/   Plain .sql, applied on boot under an advisory lock
deploy/       Caddyfile for the local two-replica cluster
```

Next.js route handlers cannot serve WebSockets, so `server/index.ts` creates the
`http.Server` itself, passes it to Next via the `httpServer` option, and attaches
`ws` to the same server's `upgrade` event. For the same reason the project does
**not** set `output: 'standalone'` — that mode does not trace custom server files
and cannot be combined with one. The container runs `node dist/server/index.js`
against real `node_modules`, and `server/` plus `shared/` are compiled by `tsc`
into `dist/` as a separate build step.

</details>

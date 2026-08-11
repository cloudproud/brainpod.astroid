<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/hero-dark.gif">
  <img src=".github/hero.gif" alt="Brainpod — build it in Claude, Cursor or Codex, host it in Europe" width="900">
</picture>

# Asteroids

**A public multiplayer Asteroids arena, and a live demo of [Brainpod](https://brainpod.io).**
No signup, no cookie banner — open the link, type a callsign, fly. One Next.js
service, one managed Postgres, one managed Valkey.

## Deploy it yourself

Clone this repository, open your coding agent in it, and paste:

```
Install the Brainpod skill from github.com/brainpodnl/skills and use it to deploy my project to Brainpod.

Sign me up using the Brainpod skills, work out what the project needs, and hand me the live URL when it's up.
```

The skill signs you up, reads the project, works out what it needs, provisions
it, and hands back a live URL.

What it provisions is the smallest shape Brainpod sells — a `.25x` app on one
replica, Postgres and Valkey at `.5x` on 5 GB disks — so the whole arena fits in
a trial account. Everything below is true at that size except the replica count
itself: for the leader-and-gateways split, raise the app to `1x` and scale it up
for as long as you are watching.

![Brainpod Asteroids](docs/screenshot.png)

## What it proves

| Brainpod claim | What demonstrates it |
|---|---|
| **Managed Postgres** | Every finished run writes one `runs` row. Six bots plus a room full of people keep that at ten to twenty inserts a minute unattended, so the database metrics graph is worth opening live. The ALL-TIME board reads straight from it. |
| **Managed Valkey** | The entire multiplayer layer: a lease elects the single authoritative simulation, `bp:snap` fans binary snapshots to every replica at 20 Hz, and the LIVE board is a sorted set. |
| **Up to 10 replicas** | Every replica runs the same image. One wins the lease and simulates; the rest are WebSocket gateways. Move the app to `1x`, scale it mid-call, and watch the `replica N of M` badge move — a trial-sized `.25x` app is held to one replica. |
| **Zero-downtime deploys** | A draining leader flushes the world to Valkey and releases its lease, so a successor resumes the same tick. Worst measured snapshot gap on a two-replica cluster: **55 ms**, against a 50 ms nominal interval. Takes the same scale-up, for the same reason. |
| **EU hosting** | The badge names the region and your RTT. Player names are the only user input, and they never leave `eu-west-1`. |
| **Per-second billing** | A 30 Hz simulation on the smallest instance sold, plus gateways that do nothing but fan out bytes once you add them. The demo costs what it uses, and at rest that is as little as this platform bills. |

## Architecture

```mermaid
flowchart LR
    subgraph browsers["Browsers"]
        direction TB
        P1["player"]
        P2["player"]
        S1["spectator"]
    end

    subgraph replicas["Replicas — one image, up to 10"]
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

Players attached to the drained replica reconnect in about **half a second**,
keeping their ship and score.

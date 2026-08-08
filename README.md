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

## Deploy it yourself

Clone this repository, open your coding agent in it, and paste:

```
Install the Brainpod skill from github.com/brainpodnl/skills and use it to deploy my project to Brainpod.

Sign me up using the Brainpod skills, work out what the project needs, and hand me the live URL when it's up.
```

The skill signs you up, reads the project, works out what it needs, provisions
it, and hands back a live URL.

![Brainpod Asteroids](docs/screenshot.png)

<img src="docs/screenshot-mobile.png" alt="Brainpod Asteroids on a phone" width="240">

## What it proves

| Brainpod claim | What demonstrates it |
|---|---|
| **Managed Postgres** | Every finished run writes one `runs` row. Six bots plus a room full of people keep that at ten to twenty inserts a minute unattended, so the database metrics graph is worth opening live. The ALL-TIME board reads straight from it. |
| **Managed Valkey** | The entire multiplayer layer: a lease elects the single authoritative simulation, `bp:snap` fans binary snapshots to every replica at 20 Hz, and the LIVE board is a sorted set. |
| **Up to 20 replicas** | Every replica runs the same image. One wins the lease and simulates; the rest are WebSocket gateways. Scale up mid-call and watch the `replica N of M` badge move. |
| **Zero-downtime deploys** | A draining leader flushes the world to Valkey and releases its lease, so a successor resumes the same tick. Worst measured snapshot gap on a two-replica cluster: **55 ms**, against a 50 ms nominal interval. |
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

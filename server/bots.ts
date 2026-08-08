import {
  BOT_MAX,
  BOT_MIN,
  BULLET_SPEED,
  INPUT_AIM,
  INPUT_FIRE,
  INPUT_THRUST,
  MAX_SHIPS,
  ROCK_RADII,
  SHIP_RADIUS,
  WORLD_H,
  WORLD_W,
} from "../shared/constants";
import { botName } from "../shared/names";
import { angleDelta, axisDelta } from "../shared/physics";
import type { Ship, Sim } from "./sim";

type Brain = {
  nextDecisionAt: number;
  desiredAng: number;
  thrust: boolean;
  fire: boolean;
  /**
   * Radians of aim error — the dial that keeps a good human run at the top of
   * the live board.
   */
  aim: number;
  reaction: number;
};

/**
 * Keeps four to six named bots in the world at all times, so the arena is never
 * empty for whoever opens the link first, and gives each one a slightly
 * different skill so they read as opponents rather than turrets.
 */
export class BotDirector {
  private brains = new Map<string, Brain>();
  private seq = 0;

  update(sim: Sim, now: number): void {
    this.balance(sim);

    for (const ship of sim.world.ships) {
      if (!ship.bot) continue;
      const brain = this.brainFor(ship);

      if (!ship.alive) {
        ship.input = 0;
        continue;
      }

      if (now >= brain.nextDecisionAt) {
        brain.nextDecisionAt = now + brain.reaction * (0.75 + Math.random() * 0.5);
        this.decide(sim, ship, brain);
      }

      this.apply(ship, brain);
    }
  }

  private balance(sim: Sim): void {
    const target = clamp(BOT_MAX - Math.floor(sim.humanCount() / 6), BOT_MIN, BOT_MAX);
    let bots = sim.botCount();
    if (bots === target) return;

    while (bots > target) {
      const victim = sim.world.ships.find((ship) => ship.bot);
      if (!victim) break;
      this.brains.delete(victim.playerId);
      sim.removeShip(victim.playerId);
      bots--;
    }

    while (bots < target && sim.world.ships.length < MAX_SHIPS) {
      const index = this.seq++;
      const added = sim.addShip({
        playerId: `bot:${index}`,
        name: botName(index),
        bot: true,
      });
      if (!added) break;
      bots++;
    }

    // A human joining a full arena evicts a bot without telling us, so its brain
    // outlives the ship. Ids never come back around, so drop the strays.
    if (this.brains.size > BOT_MAX * 2) {
      for (const playerId of this.brains.keys()) {
        if (!sim.shipFor(playerId)) this.brains.delete(playerId);
      }
    }
  }

  private brainFor(ship: Ship): Brain {
    let brain = this.brains.get(ship.playerId);
    if (!brain) {
      brain = {
        nextDecisionAt: 0,
        desiredAng: ship.ang,
        thrust: false,
        fire: false,
        aim: 0.11 + Math.random() * 0.2,
        reaction: 90 + Math.random() * 90,
      };
      this.brains.set(ship.playerId, brain);
    }
    return brain;
  }

  private decide(sim: Sim, ship: Ship, brain: Brain): void {
    const threat = nearestRock(sim, ship, true);

    if (threat && threat.clearance < 130) {
      brain.desiredAng = Math.atan2(-threat.dy, -threat.dx) + jitter(0.2);
      brain.thrust = true;
      brain.fire = threat.clearance < 120 && Math.random() < 0.7;
      return;
    }

    const target = nearestRock(sim, ship, false);

    if (!target) {
      brain.desiredAng = ship.ang + jitter(1.2);
      brain.thrust = Math.random() < 0.4;
      brain.fire = false;
      return;
    }

    const flight = target.distance / BULLET_SPEED;
    const leadX = target.dx + target.vx * flight;
    const leadY = target.dy + target.vy * flight;

    brain.desiredAng = Math.atan2(leadY, leadX) + jitter(brain.aim);
    brain.thrust = target.distance > 320 || Math.random() < 0.2;
    brain.fire = target.distance < 540;
  }

  private apply(ship: Ship, brain: Brain): void {
    const diff = angleDelta(ship.ang, brain.desiredAng);

    ship.aim = brain.desiredAng;
    ship.input = INPUT_AIM;
    if (brain.thrust && Math.abs(diff) < 0.9) ship.input |= INPUT_THRUST;
    if (brain.fire && Math.abs(diff) < 0.2) ship.input |= INPUT_FIRE;
  }
}

function nearestRock(sim: Sim, ship: Ship, byClearance: boolean) {
  let best: {
    dx: number;
    dy: number;
    vx: number;
    vy: number;
    distance: number;
    clearance: number;
  } | null = null;

  for (const rock of sim.world.rocks) {
    const dx = axisDelta(ship.x, rock.x, WORLD_W);
    const dy = axisDelta(ship.y, rock.y, WORLD_H);
    const distance = Math.hypot(dx, dy);
    const clearance = distance - ROCK_RADII[rock.size] - SHIP_RADIUS;
    const key = byClearance ? clearance : distance;
    const bestKey = best ? (byClearance ? best.clearance : best.distance) : Infinity;
    if (key < bestKey) {
      best = { dx, dy, vx: rock.vx, vy: rock.vy, distance, clearance };
    }
  }

  return best;
}

function jitter(amount: number): number {
  return (Math.random() - 0.5) * 2 * amount;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

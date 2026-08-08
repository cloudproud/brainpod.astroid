"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import DeathCard from "@/components/DeathCard";
import Leaderboard from "@/components/Leaderboard";
import { BrainpodMark } from "@/components/Marks";
import Menu from "@/components/Menu";
import StatusBadge from "@/components/StatusBadge";
import { INPUT_FIRE, INPUT_LEFT, INPUT_RIGHT } from "@/shared/constants";
import { GameClient, inputFromKeys, type HudState } from "@/lib/net";
import { Renderer } from "@/lib/render";
import { Button } from "@/components/ui/button";

const SERVER_HUD: HudState = {
  connection: "connecting",
  phase: "menu",
  shipId: null,
  name: "",
  score: 0,
  roster: [],
  humans: 0,
  spectators: 0,
  live: [],
  allTime: [],
  today: [],
  pod: "",
  replica: 1,
  replicas: 1,
  release: "",
  region: "eu-west-1",
  leader: false,
  rtt: 0,
  death: null,
  notice: null,
};

export default function Game() {
  const client = useMemo(() => new GameClient(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef(new Set<string>());
  const touchRef = useRef(0);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const hud = useSyncExternalStore(client.subscribe, client.getHud, () => SERVER_HUD);

  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, [client]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const renderer = new Renderer();
    renderer.setMonoFamily(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-jetbrains-mono")
        .trim() || "monospace",
    );

    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;

      const ratio = pixelRatio(width, height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      renderer.resize(width, height, ratio);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    let last = performance.now();
    let frame = requestAnimationFrame(function loop(now: number) {
      frame = requestAnimationFrame(loop);
      const dtMs = Math.min(now - last, 100);
      last = now;

      const keys = inputFromKeys(keysRef.current);
      client.setInput(keys | touchRef.current);

      const pointer = pointerRef.current;
      client.setAimTarget(
        pointer && !(keys & (INPUT_LEFT | INPUT_RIGHT))
          ? renderer.toWorld(pointer.x, pointer.y)
          : null,
      );

      client.advance(dtMs);

      const scene = client.sample();
      const self = scene.ships.find((ship) => ship.self) ?? null;
      const selfPosition = self ? { x: self.x, y: self.y } : null;

      renderer.ingest(client.drainEvents(), selfPosition);
      renderer.step(dtMs / 1000);
      renderer.draw(ctx, scene, selfPosition);
    });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
    };
  }, [client]);

  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.isContentEditable);

    const down = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (STEERING.has(event.code)) event.preventDefault();
      keysRef.current.add(event.code);
    };

    const up = (event: KeyboardEvent) => {
      keysRef.current.delete(event.code);
    };

    const blur = () => keysRef.current.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);

    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  /**
   * Steering is wherever the pointer is: hover on a desktop, a held finger on a
   * phone. Releasing a touch drops the target so the ship coasts rather than
   * flying at the last place a thumb happened to be.
   */
  useEffect(() => {
    const onCanvas = (event: PointerEvent) => event.target === canvasRef.current;

    const track = (event: PointerEvent) => {
      if (!onCanvas(event)) return;
      if (event.pointerType !== "mouse" && event.buttons === 0) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };

    const down = (event: PointerEvent) => {
      if (!onCanvas(event)) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      touchRef.current |= INPUT_FIRE;
    };

    const up = () => {
      touchRef.current &= ~INPUT_FIRE;
    };

    const release = (event: PointerEvent) => {
      touchRef.current &= ~INPUT_FIRE;
      if (event.pointerType !== "mouse") pointerRef.current = null;
    };

    const leave = () => {
      pointerRef.current = null;
      touchRef.current &= ~INPUT_FIRE;
    };

    window.addEventListener("pointermove", track);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", up);
    document.addEventListener("pointerleave", leave);

    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", up);
      document.removeEventListener("pointerleave", leave);
    };
  }, []);

  const flying = hud.phase === "playing" || hud.phase === "dead";
  const watching = hud.phase === "spectating";

  return (
    <main className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 sm:p-4">
        <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-edge bg-hull/80 py-1.5 pr-4 pl-2.5 backdrop-blur-sm">
          <BrainpodMark className="h-4 w-auto text-bone" />
          <span className="font-mono text-micro tracking-[0.16em] text-faint uppercase">
            Asteroids
          </span>
        </div>

        <Leaderboard
          live={hud.live}
          allTime={hud.allTime}
          today={hud.today}
          className="pointer-events-auto"
        />
      </header>

      {flying ? (
        <div className="pointer-events-none absolute top-14 left-4 z-10 flex flex-col items-start gap-1 sm:top-20 sm:right-0 sm:left-0 sm:items-center">
          <p className="font-mono text-2xl text-bone/90 tabular-nums [text-shadow:0_0_16px_var(--color-void),0_0_28px_var(--color-void)] sm:text-4xl">
            {hud.score.toLocaleString("en-US")}
          </p>
        </div>
      ) : null}

      {hud.phase === "menu" || hud.phase === "joining" ? (
        <Menu
          hud={hud}
          onPlay={(name) => client.join(name)}
          onSpectate={() => client.spectate()}
        />
      ) : null}

      {hud.phase === "dead" && hud.death ? <DeathCard death={hud.death} /> : null}

      {watching ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-4 pb-20 lg:pb-4">
          <Button
            variant="outline"
            className="pointer-events-auto"
            onClick={() => client.backToMenu()}
          >
            Join the arena
          </Button>
        </div>
      ) : null}

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 p-3 sm:p-4">
        <StatusBadge hud={hud} className="pointer-events-auto" />

        <p className="hidden font-mono text-micro tracking-[0.1em] text-ash uppercase lg:block">
          Arrows or your cursor · click to fire
        </p>
      </footer>
    </main>
  );
}

/**
 * Everything on screen is a thin stroked line, so a full 2× backing store on a
 * big window buys almost no sharpness and costs fill rate the whole frame is
 * bound by — the kind of budget a second tab of the same game blows straight
 * through. Past the cap the ratio slides down instead of the frame rate.
 */
const MAX_BACKING_PIXELS = 4_200_000;

function pixelRatio(width: number, height: number): number {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const area = width * height;
  if (area * ratio * ratio <= MAX_BACKING_PIXELS) return ratio;
  return Math.max(1, Math.sqrt(MAX_BACKING_PIXELS / area));
}

const STEERING = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Space",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
]);

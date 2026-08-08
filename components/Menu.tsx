"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { BrainpodMark } from "@/components/Marks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_NAME_LENGTH } from "@/shared/names";
import type { HudState } from "@/lib/net";

type Props = {
  hud: HudState;
  onPlay: (name: string) => void;
  onSpectate: () => void;
};

export default function Menu({ hud, onPlay, onSpectate }: Props) {
  const [name, setName] = useState("");
  const joining = hud.phase === "joining";
  const ships = hud.roster.length;

  return (
    <div className="fixed inset-0 z-20 flex flex-col items-center justify-center overflow-y-auto bg-[radial-gradient(ellipse_70%_60%_at_50%_45%,rgb(12_11_9/0.88),rgb(12_11_9/0.62))] px-5 py-10">
      <div className="animate-rise flex w-full max-w-md flex-col items-center text-center">
        <a
          href="https://brainpod.io"
          target="_blank"
          rel="noreferrer"
          className="hud-label flex items-center gap-2 transition-colors hover:text-faint"
        >
          <BrainpodMark className="h-4 w-auto text-bone" />
          Brainpod
        </a>

        <h1 className="mt-5 font-sans text-display font-medium text-bone">
          Asteroids
        </h1>

        <p className="mt-3 max-w-sm text-sm leading-relaxed text-faint">
          One arena, one authoritative simulation, however many replicas it takes.
          Fly it while we redeploy underneath you.
        </p>

        <p className="hud-label mt-4 normal-case">
          Steer with your cursor or the arrow keys · click to fire · one hit ends
          the run
        </p>

        <form
          className="mt-8 flex w-full flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onPlay(name);
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Your callsign"
            aria-label="Your callsign"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="text-center"
          />

          <Button type="submit" size="lg" disabled={joining} className="w-full">
            {joining ? "Finding you a slot…" : "Play"}
          </Button>
        </form>

        <button
          type="button"
          onClick={onSpectate}
          className="group mt-4 inline-flex items-center gap-1.5 font-mono text-micro tracking-[0.12em] text-ash uppercase transition-colors hover:text-faint"
        >
          Just watch
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </button>

        {hud.notice ? (
          <p className="mt-5 rounded-lg border border-ember/30 bg-ember/10 px-3 py-2 text-note text-ember">
            {hud.notice}
          </p>
        ) : null}

        <dl className="mt-9 grid w-full grid-cols-3 gap-px overflow-hidden rounded-xl border border-edge bg-edge">
          <Stat label="Pilots" value={hud.humans} />
          <Stat label="Ships" value={ships} />
          <Stat label="Replicas" value={hud.replicas} />
        </dl>

        <p className="hud-label mt-6 normal-case">
          Hosted in {hud.region}
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-hull/85 px-3 py-3 backdrop-blur-sm">
      <dt className="hud-label">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg text-bone tabular-nums">{value}</dd>
    </div>
  );
}

"use client";

import type { DeathSummary } from "@/lib/net";

export default function DeathCard({ death }: { death: DeathSummary }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center px-5">
      <div className="animate-rise w-full max-w-xs rounded-xl border border-ember/30 bg-hull/90 p-5 text-center backdrop-blur-sm">
        <p className="hud-label text-ember">Hit by {death.by}</p>

        <p className="mt-2 font-mono text-4xl text-bone tabular-nums">
          {death.score.toLocaleString("en-US")}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-edge pt-3">
          <Stat label="Rocks" value={death.asteroids} />
          <Stat label="Alive" value={`${Math.round(death.survivedMs / 1000)}s`} />
        </dl>

        <p className="hud-label mt-4 flex items-center justify-center gap-1.5 normal-case">
          <span className="size-1 rounded-full bg-beam/70" />
          Run written to Postgres
        </p>

        <p className="mt-3 font-mono text-micro text-faint">
          Back from zero<span className="animate-caret">_</span>
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="hud-label">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-faint tabular-nums">{value}</dd>
    </div>
  );
}

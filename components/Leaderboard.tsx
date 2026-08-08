"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { BoardEntry, RunEntry } from "@/shared/protocol";

type Props = {
  live: BoardEntry[];
  allTime: RunEntry[];
  today: RunEntry[];
  className?: string;
};

export default function Leaderboard({ live, allTime, today, className }: Props) {
  const best = today[0];

  return (
    <Tabs
      defaultValue="live"
      className={cn(
        "w-36 rounded-xl border border-edge bg-hull/80 p-2.5 backdrop-blur-sm sm:w-56 sm:p-3 lg:w-64",
        className,
      )}
    >
      <TabsList>
        <TabsTrigger value="live">Live</TabsTrigger>
        <TabsTrigger value="all-time">All-time</TabsTrigger>
      </TabsList>

      <TabsContent value="live" className="pt-2">
        <Rows
          rows={live.map((entry) => ({
            name: entry.name,
            score: entry.score,
            bot: entry.bot,
          }))}
          empty="Warming up the arena"
        />
        <Source store="Valkey" detail="zset bp:scores:live" />
      </TabsContent>

      <TabsContent value="all-time" className="pt-2">
        <Rows
          rows={allTime.map((entry) => ({ name: entry.name, score: entry.score }))}
          empty="No finished runs yet"
        />
        {best ? (
          <p className="hud-label mt-2 border-t border-edge pt-2 normal-case">
            <span className="tracking-[0.14em] uppercase">Today </span>
            <span className="text-faint">{best.name}</span>{" "}
            <span className="text-bone">{best.score.toLocaleString("en-US")}</span>
          </p>
        ) : null}
        <Source store="Postgres" detail="table runs" />
      </TabsContent>
    </Tabs>
  );
}

type Row = { name: string; score: number; bot?: boolean };

function Rows({ rows, empty }: { rows: Row[]; empty: string }) {
  if (!rows.length) {
    return <p className="py-6 text-center font-mono text-micro text-ash">{empty}</p>;
  }

  return (
    <ol className="space-y-0.5">
      {rows.slice(0, 10).map((row, index) => (
        <li
          key={`${row.name}-${index}`}
          className={cn(
            "flex items-baseline gap-2 font-mono text-micro",
            index >= 5 && "hidden sm:flex",
          )}
        >
          <span className="w-4 shrink-0 text-right text-ash tabular-nums">
            {index + 1}
          </span>
          <span
            className={cn(
              "flex-1 truncate",
              row.bot ? "text-teal/80" : "text-bone",
            )}
            title={row.name}
          >
            {row.name}
            {row.bot ? (
              <span className="ml-1 hidden text-[9px] text-teal/60 sm:inline">BOT</span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums text-faint">
            {row.score.toLocaleString("en-US")}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Source({ store, detail }: { store: string; detail: string }) {
  return (
    <p className="hud-label mt-2.5 flex items-center gap-1.5 border-t border-edge pt-2 text-[10px]">
      <span className="size-1 rounded-full bg-beam/70" />
      <span className="text-faint/70">{store}</span>
      <span className="hidden tracking-normal text-ash/70 normal-case sm:inline">
        {detail}
      </span>
    </p>
  );
}

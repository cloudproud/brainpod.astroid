"use client";

import { EuropeanFlag } from "@/components/Marks";
import { cn } from "@/lib/utils";
import type { HudState } from "@/lib/net";

export default function StatusBadge({
  hud,
  className,
}: {
  hud: HudState;
  className?: string;
}) {
  const offline = hud.connection !== "online";

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border border-edge bg-hull/80 py-1.5 pr-3.5 pl-1.5 font-mono text-[10px] tracking-[0.08em] text-ash backdrop-blur-sm",
        className,
      )}
    >
      <EuropeanFlag className="size-4 shrink-0 rounded-full" />

      <Segment>{hud.region}</Segment>
      <Dot />
      <Segment className={offline ? "text-ember" : undefined}>
        {offline ? "reconnecting" : `${hud.rtt}ms`}
      </Segment>
      <Dot />
      <Segment>
        replica {hud.replica}/{hud.replicas}
        {hud.leader ? <span className="ml-1 text-beam">sim</span> : null}
      </Segment>
      <Dot />
      <Segment className="text-faint">{hud.release || "dev"}</Segment>
    </div>
  );
}

function Segment({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("whitespace-nowrap", className)}>{children}</span>;
}

function Dot() {
  return <span className="text-edge">·</span>;
}

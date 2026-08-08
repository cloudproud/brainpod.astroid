export const PALETTE = {
  void: "#0c0b09",
  bone: "#fbfaf8",
  ash: "#6b6660",
  faint: "#a19b92",
  beam: "#4d7dff",
  teal: "#26aca9",
  ember: "#d4614c",
  gold: "#e0b64a",
  edge: "#2d2a25",
} as const;

/** Enough separation that two ships in the same corner never read as one. */
const SHIP_COLORS = [
  "#4d7dff",
  "#e0b64a",
  "#5fd08a",
  "#e88ab5",
  "#b07ce8",
  "#7fd6f0",
  "#f0906a",
  "#9fd44e",
];

export function shipColor(id: number, bot: boolean): string {
  if (bot) return PALETTE.teal;
  return SHIP_COLORS[(id * 7) % SHIP_COLORS.length];
}

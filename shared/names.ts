export const MAX_NAME_LENGTH = 16;

const BLOCKED = [
  "fuck",
  "shit",
  "cunt",
  "nigg",
  "fag",
  "rape",
  "kike",
  "spic",
  "whore",
  "slut",
  "retard",
  "hitler",
  "nazi",
];

const CALLSIGNS = [
  "COMET",
  "DRIFTER",
  "HALO",
  "IONBURN",
  "KESTREL",
  "LUMEN",
  "MERIDIAN",
  "NOVA",
  "ORBIT",
  "PULSAR",
  "QUASAR",
  "RELAY",
  "SOLSTICE",
  "TRACER",
  "VECTOR",
  "ZENITH",
];

const BOT_CALLSIGNS = [
  "ARGUS",
  "BOREAS",
  "CASSINI",
  "DELPHI",
  "ERIS",
  "FORNAX",
  "GALATEA",
  "HYPERION",
  "IAPETUS",
  "JANUS",
];

/**
 * Letters, digits and a little punctuation. Control characters, zero-width
 * joiners and combining marks all fall outside it, so they are dropped rather
 * than escaped — these names are drawn into a canvas and a leaderboard.
 */
const ALLOWED = /[^\p{L}\p{N} ._-]/gu;

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return randomCallsign();

  const stripped = raw
    .normalize("NFKC")
    .replace(ALLOWED, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .toUpperCase();

  if (stripped.length < 2) return randomCallsign();

  const flattened = stripped.replace(/[^a-z]/gi, "").toLowerCase();
  if (BLOCKED.some((word) => flattened.includes(word))) return randomCallsign();

  return stripped;
}

export function randomCallsign(): string {
  const base = CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)];
  return `${base}-${Math.floor(Math.random() * 90 + 10)}`;
}

export function botName(index: number): string {
  return BOT_CALLSIGNS[index % BOT_CALLSIGNS.length];
}

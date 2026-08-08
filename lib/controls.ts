export type ControlScheme = "cursor" | "keys";

export const CONTROL_SCHEMES: {
  value: ControlScheme;
  label: string;
  hint: string;
}[] = [
  { value: "cursor", label: "Cursor", hint: "Point to fly · click to fire" },
  { value: "keys", label: "Keyboard", hint: "Arrows or WASD · space to fire" },
];

export const DEFAULT_CONTROL_SCHEME: ControlScheme = "cursor";

const STORAGE_KEY = "bp:controls";

export function controlHint(scheme: ControlScheme): string {
  return (CONTROL_SCHEMES.find((option) => option.value === scheme) ?? CONTROL_SCHEMES[0])
    .hint;
}

/**
 * Read on mount rather than during render: the server has no idea which scheme
 * a returning player picked, and guessing here would fail hydration.
 */
export function loadControlScheme(): ControlScheme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "cursor" || stored === "keys" ? stored : DEFAULT_CONTROL_SCHEME;
  } catch {
    return DEFAULT_CONTROL_SCHEME;
  }
}

export function saveControlScheme(scheme: ControlScheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    // A blocked storage just costs the player the choice on their next visit.
  }
}

// The portal's code font: the monospace face used for code, the transcript and
// every technical surface. A person picks it in Settings › Appearance:
//
//   "theme"     the theme's own choice (the default)
//   "jetbrains" JetBrains Mono, bundled with the portal
//   "system"    the system monospace stack the portal always used
//
// A theme may name its own default with `codeFont` (Horizon Dawn uses
// JetBrains Mono); every other theme keeps the system stack.

export const CODE_FONT_CHOICES = Object.freeze(["theme", "jetbrains", "system"]);
export const DEFAULT_CODE_FONT = "theme";

/** A stored choice, or null when the value is not one of the choices. */
export function normalizeCodeFont(value) {
    return CODE_FONT_CHOICES.includes(value) ? value : null;
}

/** The face that applies: "jetbrains" or "system". */
export function resolveCodeFont(choice, theme) {
    const picked = normalizeCodeFont(choice) || DEFAULT_CODE_FONT;
    if (picked !== "theme") return picked;
    return theme?.codeFont === "jetbrains" ? "jetbrains" : "system";
}

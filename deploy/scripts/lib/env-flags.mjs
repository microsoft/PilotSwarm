const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function normalizeBooleanEnv(env, key, { defaultValue = false } = {}) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (!raw) {
    env[key] = defaultValue ? "1" : "0";
    return defaultValue;
  }
  if (TRUE_VALUES.has(raw)) {
    env[key] = "1";
    return true;
  }
  if (FALSE_VALUES.has(raw)) {
    env[key] = "0";
    return false;
  }
  throw new Error(
    `${key} must be one of 1, true, yes, on, 0, false, no, or off; got '${env[key]}'.`,
  );
}

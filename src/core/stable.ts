// JSON with every object's keys sorted: two values that mean the same thing give the same string, whatever order their keys were built in.
export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v);
}

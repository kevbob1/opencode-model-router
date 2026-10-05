/** Recognize a rejected option, not an invalid value or another request failure. */
export function rejectsTemperature(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  // Provider/SDK errors wrap causes and JSON bodies. Bound traversal and tolerate cycles.
  for (let index = 0; index < pending.length && index < 32; index++) {
    const value = pending[index];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string") {
      // Inspect structured errors, not echoed request text elsewhere in a JSON body.
      try { pending.push(JSON.parse(value)); continue; } catch { /* plain provider message */ }
      if (/\b(?:unsupported|unknown|unrecognized)\s+(?:(?:parameter|param|argument|option|field)\s*[:=]?\s*)?["'`]?temperature\b/i.test(value)
        || /\btemperature["'`]?\s+(?:(?:parameter|option|setting)\s+)?(?:is\s+)?(?:not supported|unsupported|not allowed)\b/i.test(value)
        || /\b(?:does not|doesn't|cannot)\s+support\s+(?:the\s+)?(?:(?:parameter|option|setting)\s*[:=]?\s*)?["'`]?temperature\b/i.test(value)) return true;
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.param === "temperature" && typeof record.code === "string"
        && /^(?:unsupported|unknown|unrecognized)[_-](?:parameter|param)$/.test(record.code)) return true;
      for (const key of ["message", "cause", "data", "error", "response", "body", "responseBody"]) {
        if (record[key] !== undefined) pending.push(record[key]);
      }
    }
  }
  return false;
}

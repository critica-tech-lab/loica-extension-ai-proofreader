/**
 * Outcome counters: how often suggestions are opened, accepted or dismissed,
 * by language. No text, no user id, only counts per day. The point is to learn
 * from real use whether a suggestion source earns its keep (an acceptance rate
 * per engine and language) before building anything heavier on top of it.
 *
 * This file is pure so both the browser (batching) and the server (validation)
 * can use it and tests need no database.
 */
const MAX_ROWS = 20;
const MAX_COUNT = 1000;
const OTHER = "other";
const TRACKED_LANGS = new Set(["en", "es"]);

export interface StatRow {
  lang: string;
  event: string;
  count: number;
}

/** "en-US" -> "en". Only English and Spanish are told apart; the rest is "other". */
export function normalizeLang(lang: unknown): string {
  if (typeof lang !== "string") {
    return OTHER;
  }
  const base = lang.slice(0, 2).toLowerCase();
  return TRACKED_LANGS.has(base) && (lang.length === 2 || lang[2] === "-") ? base : OTHER;
}

/** Validate untrusted rows from a client and merge duplicates. */
export function normalizeEvents(raw: unknown, allowed: readonly string[]): StatRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const merged = new Map<string, StatRow>();
  for (const item of raw.slice(0, MAX_ROWS)) {
    const { lang, event, count } = (item ?? {}) as Record<string, unknown>;
    if (typeof event !== "string" || !allowed.includes(event)) {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count)) {
      continue;
    }

    const whole = Math.min(Math.floor(count), MAX_COUNT);
    if (whole < 1) {
      continue;
    }

    const key = `${normalizeLang(lang)}|${event}`;
    const row = merged.get(key) ?? { lang: normalizeLang(lang), event, count: 0 };
    row.count = Math.min(row.count + whole, MAX_COUNT);
    merged.set(key, row);
  }
  return [...merged.values()];
}

/** Queue events in memory and hand them to `send` as one batch on `flush`. */
export function createTracker(send: (rows: StatRow[]) => void) {
  const queue = new Map<string, StatRow>();

  function track(event: string, lang: unknown): void {
    const normalized = normalizeLang(lang);
    const key = `${normalized}|${event}`;
    const row = queue.get(key) ?? { lang: normalized, event, count: 0 };
    row.count++;
    queue.set(key, row);
  }

  function flush(): void {
    if (queue.size === 0) {
      return;
    }
    const rows = [...queue.values()];
    queue.clear();
    send(rows);
  }

  return { track, flush };
}

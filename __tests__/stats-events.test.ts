import { test, expect, describe } from "bun:test";
import { normalizeLang, normalizeEvents, createTracker } from "../stats-events";

const ALLOWED = ["opened", "accepted", "learned"] as const;

describe("normalizeLang", () => {
  test("keeps English and Spanish, without the region", () => {
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("es")).toBe("es");
    expect(normalizeLang("ES-AR")).toBe("es");
  });

  test("anything else is 'other'", () => {
    expect(normalizeLang("de-DE")).toBe("other");
    expect(normalizeLang("auto")).toBe("other");
    expect(normalizeLang(undefined)).toBe("other");
    expect(normalizeLang(42)).toBe("other");
  });
});

describe("normalizeEvents", () => {
  test("accepts well-formed rows", () => {
    expect(normalizeEvents([{ lang: "en-US", event: "accepted", count: 2 }], ALLOWED)).toEqual([
      { lang: "en", event: "accepted", count: 2 },
    ]);
  });

  test("drops events outside the allow-list", () => {
    expect(normalizeEvents([{ lang: "en", event: "drop table", count: 1 }], ALLOWED)).toEqual([]);
  });

  test("returns nothing for input that is not an array", () => {
    expect(normalizeEvents({ event: "opened" }, ALLOWED)).toEqual([]);
    expect(normalizeEvents(null, ALLOWED)).toEqual([]);
    expect(normalizeEvents("opened", ALLOWED)).toEqual([]);
  });

  test("drops non-positive counts and floors fractions", () => {
    const rows = normalizeEvents(
      [
        { lang: "en", event: "opened", count: 0 },
        { lang: "en", event: "opened", count: -3 },
        { lang: "en", event: "accepted", count: 2.9 },
        { lang: "en", event: "learned", count: "5" },
      ],
      ALLOWED,
    );
    expect(rows).toEqual([{ lang: "en", event: "accepted", count: 2 }]);
  });

  test("caps a single count", () => {
    const [row] = normalizeEvents([{ lang: "en", event: "opened", count: 10 ** 9 }], ALLOWED);
    expect(row.count).toBe(1000);
  });

  test("merges rows with the same language and event", () => {
    const rows = normalizeEvents(
      [
        { lang: "en", event: "opened", count: 1 },
        { lang: "en-GB", event: "opened", count: 2 },
      ],
      ALLOWED,
    );
    expect(rows).toEqual([{ lang: "en", event: "opened", count: 3 }]);
  });

  test("ignores rows past the cap", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ lang: i % 2 ? "en" : "es", event: ALLOWED[i % 3], count: 1 }));
    const total = normalizeEvents(many, ALLOWED).reduce((sum, r) => sum + r.count, 0);
    expect(total).toBeLessThanOrEqual(20);
  });
});

describe("createTracker", () => {
  test("counts repeated events under one key", () => {
    const sent: unknown[] = [];
    const tracker = createTracker((rows) => sent.push(rows));
    tracker.track("opened", "en-US");
    tracker.track("opened", "en");
    tracker.flush();
    expect(sent).toEqual([[{ lang: "en", event: "opened", count: 2 }]]);
  });

  test("flush clears the queue", () => {
    const sent: unknown[] = [];
    const tracker = createTracker((rows) => sent.push(rows));
    tracker.track("accepted", "es");
    tracker.flush();
    tracker.flush();
    expect(sent.length).toBe(1);
  });

  test("flush with nothing queued sends nothing", () => {
    let calls = 0;
    createTracker(() => calls++).flush();
    expect(calls).toBe(0);
  });
});

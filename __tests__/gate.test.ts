import { test, expect, describe } from "bun:test";
import { createGate, GateBusyError } from "../gate";

/** A task that stays pending until `release()` is called. */
function deferred() {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { done, release };
}

describe("createGate", () => {
  test("runs a task immediately when below the active limit", async () => {
    const gate = createGate({ maxActive: 1, maxQueued: 0 });
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  test("queues a task beyond the active limit and runs it after a slot frees", async () => {
    const gate = createGate({ maxActive: 1, maxQueued: 1 });
    const first = deferred();
    const order: string[] = [];

    const a = gate.run(async () => {
      order.push("a-start");
      await first.done;
      order.push("a-end");
    });
    const b = gate.run(async () => {
      order.push("b-start");
    });

    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  test("rejects immediately when active and queue are both full", async () => {
    const gate = createGate({ maxActive: 1, maxQueued: 1 });
    const hold = deferred();
    const a = gate.run(() => hold.done);
    const b = gate.run(() => hold.done);

    await expect(gate.run(async () => "c")).rejects.toBeInstanceOf(GateBusyError);

    hold.release();
    await Promise.all([a, b]);
  });

  test("frees the slot when a task throws", async () => {
    const gate = createGate({ maxActive: 1, maxQueued: 0 });
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await gate.run(async () => "after")).toBe("after");
  });

  test("reports active and queued counts", async () => {
    const gate = createGate({ maxActive: 1, maxQueued: 2 });
    const hold = deferred();
    const a = gate.run(() => hold.done);
    const b = gate.run(() => hold.done);

    await Promise.resolve();
    expect(gate.stats()).toEqual({ active: 1, queued: 1 });

    hold.release();
    await Promise.all([a, b]);
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });
});

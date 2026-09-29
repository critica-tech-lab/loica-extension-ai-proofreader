/**
 * Concurrency gate for calls to the LLM server.
 *
 * Ollama serves a fixed number of requests at once and parks the rest in a
 * queue with no timeout. When other clients hold every slot, a Loica request
 * would wait indefinitely behind them. The gate caps how many Loica requests
 * are in flight or waiting, and rejects the overflow at once with a clear
 * error instead of letting users stare at a spinner.
 */
export class GateBusyError extends Error {
  constructor() {
    super("The AI server is busy. Try again in a minute.");
  }
}

interface GateLimits {
  /** Requests allowed to run at the same time. */
  maxActive: number;
  /** Requests allowed to wait for a free slot. */
  maxQueued: number;
}

export function createGate({ maxActive, maxQueued }: GateLimits) {
  let active = 0;
  const waiting: Array<() => void> = [];

  async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < maxActive) {
      active++;
    } else if (waiting.length < maxQueued) {
      // The slot is handed over by the task that finishes, so `active` stays put.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      throw new GateBusyError();
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  }

  function stats() {
    return { active, queued: waiting.length };
  }

  return { run, stats };
}

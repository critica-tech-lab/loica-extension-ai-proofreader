/**
 * Browser side of the outcome counters: queue events and send them in one small
 * request every few seconds, and once more when the page is hidden.
 */
import { createTracker } from "./stats-events";

const FLUSH_MS = 5000;

export function createStatsSender(docId: string) {
  const tracker = createTracker((events) => {
    // keepalive lets the request finish while the page is closing.
    fetch(`/api/proofread/${docId}/stats`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }).catch(() => {
      // Counters are best effort; never let them surface as an error.
    });
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    tracker.flush();
  };
  window.addEventListener("pagehide", flush);

  return {
    track(event: string, lang: unknown, times = 1): void {
      for (let i = 0; i < times; i++) {
        tracker.track(event, lang);
      }
      timer ??= setTimeout(flush, FLUSH_MS);
    },
    dispose(): void {
      flush();
      window.removeEventListener("pagehide", flush);
    },
  };
}

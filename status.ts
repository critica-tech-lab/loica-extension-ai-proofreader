/**
 * Publish a short message to the editor footer (see `app/extensions/status.ts`
 * in Loica for the contract). A plain browser event, so no host import is
 * needed and an older Loica just ignores it.
 */
const STATUS_EVENT = "loica:status";
const FALLBACK = "Something went wrong";
const DEFAULT_MAX = 90;

interface StatusDetail {
  id: string;
  text: string | null;
  title?: string;
  tone?: "info" | "error";
  ttlMs?: number;
}

/** True when the host footer displayed the message. */
export function publishStatus(detail: StatusDetail): boolean {
  const event = new CustomEvent(STATUS_EVENT, { detail, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** First sentence of a message, cut to fit the footer. */
export function shortMessage(message: string | undefined, max = DEFAULT_MAX): string {
  const text = (message ?? "").trim();
  if (!text) {
    return FALLBACK;
  }

  const firstSentence = text.split(/(?<=[.!?])\s/)[0];
  if (firstSentence.length <= max) {
    return firstSentence;
  }
  return `${firstSentence.slice(0, max - 1).trimEnd()}…`;
}

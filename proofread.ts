/**
 * POST /api/proofread/:id — improve a passage with a local/remote LLM (Ollama)
 * and return the improved rewrite. The client word-diffs it against the original
 * to derive DISCRETE suggestions, which it underlines inline (like LanguageTool)
 * with click-to-apply. On-demand, read-until-accepted — nothing persisted.
 *
 * Why rewrite + client-side diff (not LLM-emitted structured edits): small local
 * models rewrite reliably but are incomplete at emitting verbatim per-edit lists
 * (verified — each model misses a different subset). Diffing a full rewrite
 * recovers every change with exact positions, model-independently.
 *
 * Body: { text: string, language?: string }
 * Returns: { improved: string, model: string }
 *
 * Config: OLLAMA_URL (default http://localhost:11434),
 *         OLLAMA_PROOFREAD_MODEL (default gemma3:12b).
 */
import type { ActionFunctionArgs } from "react-router";
import { getSessionUser } from "~/lib/auth.server";
import { getDocument, getDocumentByToken } from "~/lib/document.server";
import { getMembership } from "~/lib/workspace.server";
import { hasSharedAccess } from "~/lib/sharing.server";

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq < 1) return [];
      return [[trimmed.slice(0, eq).trim(), decodeURIComponent(trimmed.slice(eq + 1).trim())]];
    }),
  );
}

/**
 * Grant access only to a workspace member, a folder-share recipient, or a caller
 * who actually presents a valid share token for *this* document.
 *
 * The earlier version treated "the document has a share token" as "no auth
 * needed", without the caller ever proving they held it — so knowing a document
 * id was enough to reach the LLM anonymously, and expired or password-protected
 * links kept working. Resolving the token via `getDocumentByToken` is the same
 * path `routes/s.$token.tsx` uses, which also enforces `share_expires_at`.
 */
async function authorizeDoc(
  request: Request,
  params: { id?: string },
  shareToken?: string,
) {
  const doc = getDocument(params.id!);
  if (!doc) throw new Response("Not found", { status: 404 });

  const user = getSessionUser(request);
  if (user) {
    const role = getMembership(doc.workspace_id, user.id, user.is_admin);
    const shared = doc.folder_id ? hasSharedAccess(doc.folder_id, user.id) : false;
    if (role || shared) return { doc, rateKey: `u:${user.id}` };
  }

  const token = shareToken?.trim();
  if (token) {
    const viaToken = getDocumentByToken(token);
    // Must resolve, and must resolve to *this* document — a valid token for some
    // other document is not access to this one.
    if (viaToken && viaToken.document.id === doc.id) {
      const passwordOk =
        !viaToken.hasPassword ||
        parseCookies(request.headers.get("Cookie") ?? "")[`__share_pwd_${token}`] === "1";
      if (passwordOk) return { doc, rateKey: `t:${token}` };
    }
  }

  throw new Response("Not found", { status: 404 });
}

// Ceiling on a single selection. Not a model limit — a patience limit: the
// default 12B model sustains ~48 source characters/second on Apple silicon, so
// 3,000 chars is a little over a minute. The old 8,000 took ~3 minutes, and
// unlike the translation route this one does not stream: the caller stares at a
// spinner for the whole run with nothing to read.
const MAX_CHARS = 3000;

// `language` is interpolated into the *system* prompt, so a free-form value lets
// a caller rewrite the model's instructions and use this route as a
// general-purpose LLM. The stock client never sets it (see `proofreadPlugin`),
// so an allowlist costs nothing and closes the hole.
const SUPPORTED_LANGS = [
  "English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch",
  "Catalan", "Chinese (Simplified)", "Japanese", "Korean", "Arabic", "Russian",
] as const;

/** Canonical language name, or undefined if unrecognised (the prompt then just
 *  tells the model to reply in the text's own language). */
function canonicalLang(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const needle = value.trim().toLowerCase();
  return SUPPORTED_LANGS.find((l) => l.toLowerCase() === needle);
}

// Each check pins the GPU for up to a minute, so an unthrottled caller can
// starve everyone else even with valid credentials. Sliding window, in-memory:
// this is per-process, so a multi-instance deployment needs a shared store.
const RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 };
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(k);
  }
  return recent.length > RATE_LIMIT.max;
}

/** Tailscale CGNAT address (100.64.0.0 – 100.127.255.255). */
function isTailscale(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** Refuse to send text over plaintext to the open internet. */
function assertSafeUrl(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`OLLAMA_URL is not a valid URL: ${base}`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "http:" && (loopback || isTailscale(host))) return;
  throw new Error(
    `Refusing to send text to ${base} over ${url.protocol.replace(":", "")}. ` +
      `Use https:// (or a loopback / Tailscale host) for the LLM server.`,
  );
}

// A precise IN-PLACE line editor: it fixes errors AND tightens wordy/redundant/
// weak phrases, but keeps the sentence structure and length, so a word-diff of
// the result yields discrete, phrase-level underlines rather than one big blob.
const SYSTEM_PROMPT =
  "You are a precise line editor. Improve the user's text with IN-PLACE edits: " +
  "fix errors (spelling, accents, grammar, agreement, punctuation) AND replace " +
  "wordy, redundant or weak phrases with tighter, stronger equivalents. STRICT " +
  "RULES: edit in place — keep the SAME sentences, the same order and roughly " +
  "the same length; do NOT merge, split, reorder or delete whole sentences; do " +
  "NOT summarise or compress the whole passage; change only the specific words " +
  "or phrases that need improving and leave the rest verbatim. Preserve the " +
  "meaning and the SAME language; keep Markdown, names, numbers, URLs and code " +
  "unchanged. Output ONLY the edited text — no preamble, no explanation, no " +
  "surrounding quotes.";

async function proofread(
  text: string,
  language: string | undefined,
): Promise<{ improved: string; model: string }> {
  const base = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
  assertSafeUrl(base);
  const model = process.env.OLLAMA_PROOFREAD_MODEL || "gemma3:12b";
  const langLine = language
    ? `The text is in ${language}; reply in ${language}.`
    : "Reply in the same language as the text.";

  // Size the context window to the actual selection instead of leaving Ollama's
  // default: input (+few-shot ≈800 tok) plus room for a same-length rewrite.
  // Small selections get a small KV cache (less VRAM, faster) — the efficiency
  // win on limited hardware — while big ones still fit without truncation.
  const estTokens = Math.ceil(text.length / 4);
  const numCtx = Math.min(8192, Math.max(2048, estTokens * 2 + 800));

  let res: Response;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        // Keep the model resident between checks so an on-demand check after a
        // pause doesn't pay a cold reload — the biggest per-request latency win.
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
        options: { temperature: 0.15, num_ctx: numCtx },
        messages: [
          { role: "system", content: `${SYSTEM_PROMPT} ${langLine}` },
          // Few-shot: demonstrate the KIND of in-place edits wanted (cut filler,
          // tighten wordy phrases, fix errors) in both languages, so the model
          // does more than spellcheck yet keeps sentence structure.
          {
            role: "user",
            content:
              "En el día de hoy quiero comentar que basicamente la situacion que estamos viviendo nos afecta a todos nosotros de forma bastante negativa.",
          },
          {
            role: "assistant",
            content: "Hoy quiero comentar que la situación que vivimos nos afecta a todos muy negativamente.",
          },
          {
            role: "user",
            content:
              "In todays meeting we basically came to the conclusion that we should try to make an effort in order to improve the situation.",
          },
          {
            role: "assistant",
            content: "In today's meeting we concluded that we should make an effort to improve the situation.",
          },
          { role: "user", content: text },
        ],
      }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the LLM at ${base}. Is Ollama running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM returned ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const improved = (data.message?.content ?? "").trim();
  if (!improved) throw new Error("The model returned an empty result.");
  return { improved, model };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { text, language, shareToken } = (await request.json()) as {
    text?: string;
    language?: string;
    shareToken?: string;
  };

  // The share token travels in the body, so parse before authorizing.
  const { rateKey } = await authorizeDoc(request, params, shareToken);

  if (rateLimited(rateKey)) {
    return Response.json(
      { error: "Too many checks — wait a few minutes and try again." },
      { status: 429 },
    );
  }

  if (!text || !text.trim()) {
    return Response.json({ error: "No text to check." }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return Response.json(
      {
        error:
          `Selection is ${text.length.toLocaleString()} characters — the limit is ` +
          `${MAX_CHARS.toLocaleString()}. Check a few paragraphs at a time.`,
      },
      { status: 413 },
    );
  }

  try {
    const { improved, model } = await proofread(text, canonicalLang(language));
    return Response.json({ improved, model });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Proofread failed." },
      { status: 502 },
    );
  }
}

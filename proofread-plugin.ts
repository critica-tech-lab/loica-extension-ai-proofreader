/**
 * ProseMirror plugin: on-demand AI proofreading rendered INLINE, like
 * LanguageTool.
 *
 * The user selects a passage; a small "✨ Check" button floats near it. Clicking
 * sends the selection to `/api/proofread/:id` (LLM), which returns discrete
 * suggestions. Each suggestion's exact substring is located in the doc and
 * underlined (wavy, coloured by type); clicking an underline shows the reason
 * and an Apply button that swaps in the fix.
 *
 * On-demand (never on keystroke) and read-until-accepted. Runs in the host's
 * ProseMirror instance (bare `prosemirror-*` imports + vite `dedupe`). All
 * callbacks self-guard so a failure can't break the editor.
 *
 * (The floating button is a temporary trigger — it will move into loica's
 * native selection menu once the `selectionMenuItems` seam lands.)
 */
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export const proofreadPluginKey = new PluginKey<DecorationSet>("ai-proofread");

const MIN_CHARS = 12;
// Keep in sync with MAX_CHARS in proofread.ts — checked here too so an oversized
// selection fails instantly with a number instead of after a round trip.
const MAX_CHARS = 3000;

// Cache LLM rewrites by exact selection text so re-checking an unchanged passage
// is instant (no call). Capped, module-level (shared for the page's lifetime).
const proofreadCache = new Map<string, string>();
function cacheSet(key: string, val: string) {
  proofreadCache.set(key, val);
  if (proofreadCache.size > 200) {
    const first = proofreadCache.keys().next().value;
    if (first !== undefined) proofreadCache.delete(first);
  }
}

interface Edit {
  wrong: string;
  fix: string;
  why: string;
  type: string;
}

// AI suggestions are ALWAYS violet, so the user can tell them apart at a glance:
// red/amber wavy = LanguageTool (corrections), violet wavy = AI.
function typeColor(_type: string): string {
  return "#7b5cd6";
}

// ── selection serialisation + offset → PM position ──────────────────────────

interface Seg { textStart: number; pmFrom: number; len: number }

/**
 * Serialise ONLY the selection [from, to] to plain text, recording an offset →
 * PM-position map for each text run (block breaks become "\n"). Offsets are in
 * the selection's own coordinate space — exactly what the diff below produces.
 */
function selectionToText(doc: PMNode, from: number, to: number): { text: string; segs: Seg[] } {
  const segs: Seg[] = [];
  let text = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText && node.text) {
      const a = Math.max(pos, from);
      const b = Math.min(pos + node.text.length, to);
      if (b > a) {
        const slice = node.text.slice(a - pos, b - pos);
        segs.push({ textStart: text.length, pmFrom: a, len: slice.length });
        text += slice;
      }
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
    return true;
  });
  return { text, segs };
}

function offsetToPos(segs: Seg[], offset: number): number | null {
  for (const s of segs) {
    if (offset >= s.textStart && offset < s.textStart + s.len) {
      return s.pmFrom + (offset - s.textStart);
    }
  }
  return null;
}

interface DiffPart { value: string; added?: boolean; removed?: boolean }

/** Split into words / whitespace / punctuation runs (tokens). */
function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Minimal token-level diff (LCS) — self-contained so the extension needs no
 * host dependency beyond ProseMirror. Returns jsdiff-shaped parts.
 */
function wordDiff(a: string, b: string): DiffPart[] {
  const A = tokenize(a), B = tokenize(b);
  const n = A.length, m = B.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ value: string; kind: "eq" | "add" | "rem" }> = [];
  const push = (value: string, kind: "eq" | "add" | "rem") => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.value += value;
    else out.push({ value, kind });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push(A[i], "eq"); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(A[i], "rem"); i++; }
    else { push(B[j], "add"); j++; }
  }
  while (i < n) { push(A[i], "rem"); i++; }
  while (j < m) { push(B[j], "add"); j++; }
  return out.map((p) => ({
    value: p.value,
    added: p.kind === "add" || undefined,
    removed: p.kind === "rem" || undefined,
  }));
}

interface Change { offset: number; len: number; wrong: string; fix: string; type: string; why: string }

/**
 * Classify a change from its wrong→fix pattern — no LLM call, so it adds zero
 * latency. Labels are always English (UI language), independent of the text's
 * own language. Covers the common cases; falls back to a generic label.
 */
function classify(wrong: string, fix: string): { type: string; why: string } {
  const isPunct = (x: string) => /^[^\p{L}\p{N}\s]+$/u.test(x);
  const strip = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!fix) return { type: "redundant", why: "Unnecessary word" };
  if (isPunct(wrong) && isPunct(fix)) return { type: "punctuation", why: "Punctuation" };
  const single = !/\s/.test(wrong) && !/\s/.test(fix);
  if (single) {
    if (wrong.toLowerCase() === fix.toLowerCase()) return { type: "capitalization", why: "Capitalization" };
    if (strip(wrong) === strip(fix)) return { type: "accent", why: "Accent mark" };
    return { type: "spelling", why: "Spelling" };
  }
  return { type: "clarity", why: "Clearer phrasing" };
}

/**
 * Word-diff the original selection against the LLM rewrite and reduce it to
 * discrete changes: each has the exact offset+length of the wrong span in the
 * selection, its replacement, and a heuristic type/reason. Order-independent;
 * pure insertions (no span to underline) are skipped for now.
 */
function diffToChanges(selText: string, improved: string): Change[] {
  const parts = wordDiff(selText, improved);
  const changes: Change[] = [];
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      off += p.value.length;
      continue;
    }
    // Gather a contiguous run of added/removed parts into one change hunk.
    let removed = "", added = "";
    const start = off;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) removed += parts[i].value;
      else added += parts[i].value;
      i++;
    }
    i--; // the for-loop's ++ re-lands on the next unchanged part
    const lead = removed.length - removed.trimStart().length;
    const wrong = removed.trim();
    const fix = added.trim();
    if (wrong) {
      const { type, why } = classify(wrong, fix);
      changes.push({ offset: start + lead, len: wrong.length, wrong, fix, type, why });
    }
    off = start + removed.length;
  }
  return changes;
}

/** Turn located changes into non-overlapping inline decorations. */
function changesToDecorations(doc: PMNode, segs: Seg[], changes: Change[]): DecorationSet {
  const max = doc.content.size;
  const decos: Decoration[] = [];
  for (const c of changes) {
    try {
      const rawFrom = offsetToPos(segs, c.offset);
      const rawLast = offsetToPos(segs, c.offset + c.len - 1);
      if (rawFrom == null || rawLast == null) continue;
      const from = Math.max(0, Math.min(rawFrom, max));
      const to = Math.max(0, Math.min(rawLast + 1, max));
      if (to <= from) continue;
      const color = typeColor(c.type);
      decos.push(
        Decoration.inline(
          from,
          to,
          {
            class: "ai-proofread-issue",
            style: `text-decoration: underline; text-decoration-color: ${color}; text-decoration-thickness: 1.5px; text-underline-offset: 2px; cursor: pointer;`,
          },
          { aiEdit: { wrong: c.wrong, fix: c.fix, why: c.why, type: c.type }, aiFrom: from, aiTo: to },
        ),
      );
    } catch {
      /* skip a bad change */
    }
  }
  try {
    return DecorationSet.create(doc, decos);
  } catch {
    return DecorationSet.empty;
  }
}

// ── click-to-apply popover ───────────────────────────────────────────────────

let activePopover: HTMLElement | null = null;

function closePopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("scroll", closePopover, true);
  }
}
function onDocMouseDown(e: MouseEvent) {
  if (activePopover && !activePopover.contains(e.target as Node)) closePopover();
}

function openPopover(view: EditorView, edit: Edit, from: number, to: number, x: number, y: number) {
  closePopover();
  const pop = document.createElement("div");
  Object.assign(pop.style, {
    position: "fixed",
    left: `${Math.min(x, window.innerWidth - 300)}px`,
    top: `${y + 12}px`,
    width: "min(300px, 92vw)",
    background: "var(--bg, #fff)",
    color: "var(--fg, #111)",
    border: "1px solid var(--border, #ccc)",
    borderRadius: "9px",
    boxShadow: "0 6px 26px rgba(0,0,0,0.2)",
    padding: "11px 13px",
    zIndex: "2000",
    fontSize: "13px",
    lineHeight: "1.5",
  } as CSSStyleDeclaration);

  const cat = document.createElement("div");
  cat.textContent = edit.type;
  Object.assign(cat.style, {
    fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em",
    opacity: "0.55", marginBottom: "4px",
  } as CSSStyleDeclaration);
  pop.appendChild(cat);

  if (edit.why) {
    const why = document.createElement("div");
    why.textContent = edit.why;
    why.style.marginBottom = "8px";
    pop.appendChild(why);
  }

  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } as CSSStyleDeclaration);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = edit.fix || "(delete)";
  Object.assign(apply.style, {
    padding: "3px 10px", borderRadius: "999px", border: "none",
    background: "var(--fg, #111)", color: "var(--bg, #fff)",
    fontSize: "12px", fontWeight: "600", cursor: "pointer",
  } as CSSStyleDeclaration);
  apply.addEventListener("click", () => {
    try {
      const size = view.state.doc.content.size;
      const f = Math.max(0, Math.min(from, size));
      const t = Math.max(f, Math.min(to, size));
      view.dispatch(view.state.tr.insertText(edit.fix, f, t));
    } catch { /* ignore */ }
    closePopover();
    view.focus();
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  Object.assign(dismiss.style, {
    padding: "3px 10px", borderRadius: "999px", border: "1px solid var(--border, #ccc)",
    background: "transparent", color: "var(--fg, #111)", fontSize: "12px", cursor: "pointer",
  } as CSSStyleDeclaration);
  dismiss.addEventListener("click", () => closePopover());

  row.append(apply, dismiss);
  pop.appendChild(row);
  document.body.appendChild(pop);
  activePopover = pop;
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("scroll", closePopover, true);
}

// ── check runner (triggered from the selection menu) ─────────────────────────

const busyViews = new WeakSet<EditorView>();

/** Brief toast near the selection — the only feedback now that there's no button. */
function flash(view: EditorView, msg: string) {
  try {
    let left = window.innerWidth / 2, top = 80;
    try {
      const c = view.coordsAtPos(view.state.selection.to);
      left = c.left; top = c.bottom + 8;
    } catch { /* fall back to centre-top */ }
    const t = document.createElement("div");
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", left: `${Math.min(left, window.innerWidth - 170)}px`, top: `${top}px`,
      zIndex: "1600", padding: "4px 10px", fontSize: "12px",
      background: "var(--fg, #111)", color: "var(--bg, #fff)",
      borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.2)", pointerEvents: "none",
    } as CSSStyleDeclaration);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  } catch { /* ignore */ }
}

// ── pending state (pulse + spinner chip) ─────────────────────────────────────

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
@keyframes ai-proofread-pulse { 0%,100% { background: color-mix(in srgb, #7b5cd6 8%, transparent); } 50% { background: color-mix(in srgb, #7b5cd6 26%, transparent); } }
.ai-proofread-pending { animation: ai-proofread-pulse 1.1s ease-in-out infinite; border-radius: 3px; }
@keyframes ai-proofread-spin { to { transform: rotate(360deg); } }
.ai-proofread-spinner { display:inline-block; width:11px; height:11px; border:2px solid currentColor; border-top-color: transparent; border-radius:50%; animation: ai-proofread-spin .7s linear infinite; }
.ai-proofread-chip { position:fixed; z-index:1600; padding:4px 11px; font-size:12px; display:inline-flex; align-items:center; gap:7px; background: var(--fg,#111); color: var(--bg,#fff); border-radius:999px; box-shadow:0 2px 10px rgba(0,0,0,0.22); pointer-events:none; }
`;
  document.head.appendChild(s);
}

/** Pulsing highlight over the passage being checked (multi-line aware). */
function pendingDecos(doc: PMNode, from: number, to: number): DecorationSet {
  try {
    return DecorationSet.create(doc, [Decoration.inline(from, to, { class: "ai-proofread-pending" })]);
  } catch {
    return DecorationSet.empty;
  }
}

// This route does not stream — the caller waits the full run with nothing to
// read — so the wait has to be legible or it reads as a hang. Measured
// throughput for the default 12B on Apple silicon is ~48 source chars/second,
// plus a couple of seconds of warm-up. A different model shifts this, so it is
// a hint, never a promise.
function etaSeconds(chars: number): number {
  return Math.max(5, Math.round((chars / 48 + 2) / 5) * 5);
}

let chipEl: HTMLElement | null = null;
let chipTicker: ReturnType<typeof setInterval> | undefined;
function showChip(view: EditorView, at: number, chars = 0) {
  hideChip();
  const el = document.createElement("div");
  el.className = "ai-proofread-chip";
  const spin = document.createElement("span");
  spin.className = "ai-proofread-spinner";
  const label = document.createTextNode("Checking…");
  el.append(spin, label);

  if (chars > 0) {
    const eta = etaSeconds(chars);
    const startedAt = Date.now();
    label.textContent = `Checking… ~${eta}s`;
    chipTicker = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      label.textContent = `Checking… ${elapsed}s of ~${eta}s`;
    }, 1000);
  }
  try {
    const c = view.coordsAtPos(at);
    el.style.left = `${Math.min(c.left, window.innerWidth - 130)}px`;
    el.style.top = `${c.bottom + 8}px`;
  } catch {
    el.style.left = "50%";
    el.style.top = "80px";
  }
  document.body.appendChild(el);
  chipEl = el;
}
function hideChip() {
  if (chipTicker !== undefined) {
    clearInterval(chipTicker);
    chipTicker = undefined;
  }
  if (chipEl) {
    chipEl.remove();
    chipEl = null;
  }
}

/**
 * The share token for a publicly-viewed document, read off `/s/:token`. Members
 * viewing a document normally are on a different path and get `null` — they are
 * authorised by session instead.
 */
function shareTokenFromLocation(): string | null {
  const m = window.location.pathname.match(/^\/s\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Fetch (or cache) the LLM edit for a selection. Cache keyed by exact text. */
async function getImproved(opts: ProofreadPluginOptions, selText: string): Promise<string> {
  const cached = proofreadCache.get(selText);
  if (cached !== undefined) return cached;
  const res = await fetch(`/api/proofread/${opts.docId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: selText,
      language: opts.language,
      shareToken: shareTokenFromLocation() || undefined,
    }),
  });
  const data = (await res.json()) as { improved?: string; error?: string };
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  const improved = data.improved || selText;
  cacheSet(selText, improved);
  return improved;
}

/** Read the current selection (or flash a hint and return null). */
function currentSelection(
  view: EditorView,
): { from: number; to: number; text: string; segs: Seg[] } | null {
  const s = view.state.selection;
  if (s.empty || s.to - s.from < MIN_CHARS) {
    flash(view, "Select a sentence or two first");
    return null;
  }
  const { text, segs } = selectionToText(view.state.doc, s.from, s.to);
  if (!text.trim()) return null;
  if (text.length > MAX_CHARS) {
    flash(
      view,
      `Selection is ${text.length.toLocaleString()} characters — check up to ` +
        `${MAX_CHARS.toLocaleString()} at a time (about a minute).`,
    );
    return null;
  }
  return { from: s.from, to: s.to, text, segs };
}

/**
 * "Check" — minimal corrections rendered as inline underlines. Invoked from the
 * selection-menu item (`index.ts`). No-op if the selection is empty/short/busy.
 */
export async function runProofreadCheck(view: EditorView, opts: ProofreadPluginOptions): Promise<void> {
  if (busyViews.has(view)) return;
  const sel = currentSelection(view);
  if (!sel) return;
  busyViews.add(view);
  injectStyles();

  // Collapse the selection and mark the passage as "pending": a pulsing
  // highlight over the exact text + a spinner chip, both alive for the whole
  // request so the user sees this paragraph is being worked on.
  {
    const tr = view.state.tr.setMeta(proofreadPluginKey, pendingDecos(view.state.doc, sel.from, sel.to));
    try {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(sel.to, tr.doc.content.size)));
    } catch { /* keep selection if collapsing fails */ }
    view.dispatch(tr);
    try {
      view.focus();
      window.getSelection()?.removeAllRanges();
    } catch { /* ignore */ }
  }
  showChip(view, sel.to, sel.text.length);

  try {
    const improved = await getImproved(opts, sel.text);
    const changes = diffToChanges(sel.text, improved);
    const decos = changesToDecorations(view.state.doc, sel.segs, changes);
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, decos)); // replaces the pulse
    if (changes.length === 0) flash(view, "No issues found ✓");
  } catch (err) {
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, DecorationSet.empty)); // clear the pulse
    flash(view, err instanceof Error ? err.message : "Check failed");
  } finally {
    hideChip();
    busyViews.delete(view);
  }
}

// ── plugin ───────────────────────────────────────────────────────────────────

export interface ProofreadPluginOptions {
  docId: string;
  language?: string;
}

export function proofreadPlugin(opts: ProofreadPluginOptions): Plugin {
  return new Plugin<DecorationSet>({
    key: proofreadPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, old: DecorationSet) {
        try {
          const meta = tr.getMeta(proofreadPluginKey) as DecorationSet | undefined;
          if (meta) return meta;
          return old.map(tr.mapping, tr.doc);
        } catch {
          return DecorationSet.empty;
        }
      },
    },
    props: {
      decorations(state: EditorState) {
        return proofreadPluginKey.getState(state) ?? DecorationSet.empty;
      },
      handleClick(view: EditorView, pos: number, event: MouseEvent) {
        try {
          const set = proofreadPluginKey.getState(view.state);
          if (!set) return false;
          const hit = set.find(pos, pos)[0];
          if (!hit) return false;
          const spec = hit.spec as { aiEdit?: Edit; aiFrom?: number; aiTo?: number };
          if (!spec.aiEdit) return false;
          openPopover(view, spec.aiEdit, spec.aiFrom!, spec.aiTo!, event.clientX, event.clientY);
          return true;
        } catch {
          return false;
        }
      },
    },
    view() {
      // No UI of its own — the trigger lives in the selection menu
      // (`runProofreadCheck`). Just tidy up any open popover / chip on teardown.
      return {
        destroy: () => {
          closePopover();
          hideChip();
        },
      };
    },
  });
}

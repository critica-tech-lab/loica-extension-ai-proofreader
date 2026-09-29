/**
 * The two things the proofreader can be asked to do.
 *
 *   fix      correct objective errors only (spelling, accents, grammar,
 *            agreement, punctuation) and leave every correct word alone.
 *   improve  also tighten wordy or weak phrasing, which rewrites text.
 *
 * They need separate prompts. On a benchmark of clean sentences, the improving
 * prompt rewrote 42 to 51% of sentences that had no error, so it cannot double
 * as a checker; the fix prompt touched 0 to 2% of them.
 */
export type Mode = "fix" | "improve";

interface Prompt {
  system: string;
  /** [user, assistant] example pairs, sent before the real text. */
  shots: Array<[string, string]>;
}

const DEFAULT_MODEL = "gemma3:12b";

const FIX_SYSTEM =
  "You are a proofreader. Fix ONLY objective errors: spelling, accents, grammar, " +
  "agreement, capitalization, punctuation. Do NOT change wording, style or tone. " +
  "If the text has no errors, return it exactly unchanged. Keep Markdown, names, " +
  "numbers, URLs and code unchanged. Output ONLY the corrected text, no preamble, " +
  "no explanation, no quotes.";

// A precise IN-PLACE line editor: it fixes errors AND tightens wordy/redundant/
// weak phrases, but keeps the sentence structure and length, so a word-diff of
// the result yields discrete, phrase-level underlines rather than one big blob.
const IMPROVE_SYSTEM =
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

// Examples in both languages, including one that must come back untouched.
const FIX_SHOTS: Array<[string, string]> = [
  ["Ayer fuimos a la reunion y el equipo aprovo la propuesta.", "Ayer fuimos a la reunión y el equipo aprobó la propuesta."],
  ["We discussed the plan and it's timeline yesterday.", "We discussed the plan and its timeline yesterday."],
  ["The report is ready for review.", "The report is ready for review."],
];

// Few-shot: demonstrate the KIND of in-place edits wanted (cut filler, tighten
// wordy phrases, fix errors) in both languages, so the model does more than
// spellcheck yet keeps sentence structure.
const IMPROVE_SHOTS: Array<[string, string]> = [
  [
    "En el día de hoy quiero comentar que basicamente la situacion que estamos viviendo nos afecta a todos nosotros de forma bastante negativa.",
    "Hoy quiero comentar que la situación que vivimos nos afecta a todos muy negativamente.",
  ],
  [
    "In todays meeting we basically came to the conclusion that we should try to make an effort in order to improve the situation.",
    "In today's meeting we concluded that we should make an effort to improve the situation.",
  ],
];

/** Anything other than the exact string "improve" is the safe mode, fix. */
export function parseMode(value: unknown): Mode {
  return value === "improve" ? "improve" : "fix";
}

export function promptFor(mode: Mode): Prompt {
  if (mode === "improve") {
    return { system: IMPROVE_SYSTEM, shots: IMPROVE_SHOTS };
  }
  return { system: FIX_SYSTEM, shots: FIX_SHOTS };
}

/** Model for a mode. Improve can use a larger model than fix. */
export function modelFor(mode: Mode, env: Record<string, string | undefined>): string {
  const base = env.OLLAMA_PROOFREAD_MODEL || DEFAULT_MODEL;
  if (mode === "improve") {
    return env.OLLAMA_IMPROVE_MODEL || base;
  }
  return base;
}

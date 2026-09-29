/**
 * English or Spanish detection for a passage, used only to label outcome
 * counters by language. Same stopword method as `detectLang` in the
 * LanguageTool extension (`languages.ts`); it is repeated here because an
 * extension may not import another one.
 */
export type Lang = "en" | "es";

const MIN_SIGNAL = 2;
const SPANISH_MARK_WEIGHT = 3;

// Words shared by both languages ("a", "me", "no", "he") are left out on purpose.
const EN_WORDS = new Set(
  ("the and of to is are was were in that it for with this on as be by not have has you your " +
    "they their we our but or an at from will would should can its it's i my what which there " +
    "than then been more all if so does don't").split(" "),
);
const ES_WORDS = new Set(
  ("el la los las de del que y en un una es son fue por para con se su sus al lo como más pero " +
    "muy sin sobre este esta esto ese esa estos están está hay ya también nos le les mi tu yo " +
    "él ella ellos cuando donde porque si entre todos").split(" "),
);

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** English or Spanish, or null when the text has too little signal to tell. */
export function detectLang(text: string): Lang | null {
  const lower = text.toLowerCase();
  const words = lower.match(/[\p{L}']+/gu) ?? [];

  let en = 0;
  let es = 0;
  for (const word of words) {
    if (EN_WORDS.has(word)) {
      en++;
    }
    if (ES_WORDS.has(word)) {
      es++;
    }
  }
  es += countMatches(lower, /[¿¡ñ]/g) * SPANISH_MARK_WEIGHT;
  es += countMatches(lower, /[áéíóú]/g);

  if (es >= MIN_SIGNAL && es > en) {
    return "es";
  }
  if (en >= MIN_SIGNAL && en > es) {
    return "en";
  }
  return null;
}

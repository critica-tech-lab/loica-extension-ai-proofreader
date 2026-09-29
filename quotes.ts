/**
 * Models (Gemma in particular) rewrite straight quotes as typographic ones:
 * "It's" comes back as "It’s". The client word-diffs the rewrite against the
 * original, so every such apostrophe would be underlined as a "spelling" fix
 * on text that had no error. If the original used no typographic quotes,
 * neither should the rewrite.
 */
const TYPOGRAPHIC = /[‘’“”]/;

export function matchQuotes(original: string, improved: string): string {
  if (TYPOGRAPHIC.test(original)) {
    return improved;
  }

  return improved.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

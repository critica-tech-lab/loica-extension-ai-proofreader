/**
 * AI Proofreader extension (server registry entry).
 *
 * Registers the extension server-side so it appears in `serverExtensions` and
 * can be enabled by an admin — which gates the client editor plugin. The work
 * lives in the `/api/proofread/:id` route (`proofread.ts` → Ollama).
 */
import type { LoicaExtension } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";

const aiProofreaderServerExtension: LoicaExtension = {
  id: "ai-proofreader",
  apiVersion: LOICA_EXTENSION_API_VERSION,
  version: "0.1.0",
  description:
    "On-demand AI proofreading of the selected text via a local/remote LLM (Ollama). Improves grammar, clarity and phrasing; review-and-replace. Read-only until accepted.",
  defaultEnabled: false,
};

export default aiProofreaderServerExtension;

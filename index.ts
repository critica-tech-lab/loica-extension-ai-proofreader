/**
 * AI Proofreader extension (client registry entry).
 *
 * Contributes an editor plugin (via the `editorPlugins` seam) that offers
 * on-demand LLM proofreading of the current selection: select text → "✨ Improve"
 * → review the suggestion → Replace. Read-until-accepted; never edits on its own.
 *
 * Auto-discovered by the host registry glob — this file just `export default`s a
 * `LoicaExtension`. Server half in `index.server.ts`.
 */
import type { LoicaExtension, ExtensionEditorPluginContext } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";
import type { EditorView } from "prosemirror-view";
import { proofreadPlugin, runProofreadCheck } from "./proofread-plugin";

const aiProofreaderExtension: LoicaExtension = {
  id: "ai-proofreader",
  apiVersion: LOICA_EXTENSION_API_VERSION,
  version: "0.1.0",
  description:
    "On-demand AI proofreading of the selected text via a local/remote LLM (Ollama). Improves grammar, clarity and phrasing; review-and-replace. Read-only until accepted.",
  // Off until an admin turns it on: it needs a reachable LLM server.
  defaultEnabled: false,
  // Renders the issue underlines + click-to-fix popover in the editor.
  editorPlugins: (ctx: ExtensionEditorPluginContext) => [
    proofreadPlugin({ docId: ctx.docId }),
  ],
  // Trigger lives in loica's native text-selection menu (not a floating button):
  // an in-place line edit rendered as discrete inline underlines.
  selectionMenuItems: (ctx: ExtensionEditorPluginContext) => [
    {
      label: "Check",
      title: "Check spelling, grammar and phrasing",
      run: (view) => runProofreadCheck(view as EditorView, { docId: ctx.docId }),
    },
  ],
};

export default aiProofreaderExtension;

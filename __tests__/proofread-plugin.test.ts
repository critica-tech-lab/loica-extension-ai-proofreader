import { test, expect, describe } from "bun:test";
import { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { proofreadPlugin, proofreadPluginKey } from "../proofread-plugin";

/** "aa bad cc" with a suggestion decoration over "bad" (positions 4..7). */
function stateWithSuggestion() {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("aa bad cc")])]);
  let state = EditorState.create({ doc, plugins: [proofreadPlugin({ docId: "d" })] });
  const set = DecorationSet.create(state.doc, [
    Decoration.inline(4, 7, { class: "ai-proofread-issue" }, { aiEdit: { wrong: "bad", fix: "good" } }),
  ]);
  state = state.apply(state.tr.setMeta(proofreadPluginKey, set));
  return state;
}

function decoCount(state: EditorState): number {
  return proofreadPluginKey.getState(state)!.find().length;
}

describe("suggestion underline after an edit", () => {
  test("is dropped once its text is replaced by the accepted fix", () => {
    const state = stateWithSuggestion();
    const next = state.apply(state.tr.insertText("good", 4, 7));
    expect(decoCount(next)).toBe(0);
  });

  test("survives an edit elsewhere and keeps tracking its text", () => {
    const state = stateWithSuggestion();
    const next = state.apply(state.tr.insertText("zz ", 1, 1));
    const [deco] = proofreadPluginKey.getState(next)!.find();
    expect(next.doc.textBetween(deco.from, deco.to)).toBe("bad");
  });

  test("does not drop a neighbouring suggestion that only touches the edit", () => {
    const state = stateWithSuggestion();
    // Replace "aa " (1..4), which ends exactly where the suggestion starts.
    const next = state.apply(state.tr.insertText("xx ", 1, 4));
    expect(decoCount(next)).toBe(1);
  });
});

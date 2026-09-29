import { test, expect, describe } from "bun:test";
import { parseMode, promptFor, modelFor } from "../prompts";

describe("parseMode", () => {
  test("only the exact string 'improve' selects improve", () => {
    expect(parseMode("improve")).toBe("improve");
  });

  test("everything else falls back to fix", () => {
    expect(parseMode("fix")).toBe("fix");
    expect(parseMode(undefined)).toBe("fix");
    expect(parseMode(null)).toBe("fix");
    expect(parseMode("IMPROVE")).toBe("fix");
    expect(parseMode(42)).toBe("fix");
  });
});

describe("promptFor", () => {
  test("fix forbids rewording and never asks for tighter phrasing", () => {
    const { system } = promptFor("fix");
    expect(system).toContain("Do NOT change wording");
    expect(system).not.toContain("tighter");
  });

  test("improve keeps the tightening instruction", () => {
    expect(promptFor("improve").system).toContain("tighter");
  });

  test("fix examples include a sentence returned unchanged", () => {
    const { shots } = promptFor("fix");
    expect(shots.some(([input, output]) => input === output)).toBe(true);
  });

  test("both modes come with examples in English and Spanish", () => {
    for (const mode of ["fix", "improve"] as const) {
      const text = promptFor(mode).shots.map(([input]) => input).join(" ");
      expect(text).toMatch(/\b(the|we|it's)\b/i);
      expect(text).toMatch(/\b(el|la|que|fuimos)\b/i);
    }
  });
});

describe("modelFor", () => {
  test("defaults to gemma3:12b in both modes", () => {
    expect(modelFor("fix", {})).toBe("gemma3:12b");
    expect(modelFor("improve", {})).toBe("gemma3:12b");
  });

  test("OLLAMA_PROOFREAD_MODEL applies to both modes", () => {
    const env = { OLLAMA_PROOFREAD_MODEL: "qwen2.5:7b" };
    expect(modelFor("fix", env)).toBe("qwen2.5:7b");
    expect(modelFor("improve", env)).toBe("qwen2.5:7b");
  });

  test("OLLAMA_IMPROVE_MODEL overrides improve only", () => {
    const env = { OLLAMA_PROOFREAD_MODEL: "gemma3:4b", OLLAMA_IMPROVE_MODEL: "gemma3:27b" };
    expect(modelFor("fix", env)).toBe("gemma3:4b");
    expect(modelFor("improve", env)).toBe("gemma3:27b");
  });
});

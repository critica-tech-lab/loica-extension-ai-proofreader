import { test, expect, describe } from "bun:test";
import { matchQuotes } from "../quotes";

describe("matchQuotes", () => {
  test("curly apostrophes become straight when the original used none", () => {
    expect(matchQuotes("It's a small change.", "It’s a small change.")).toBe("It's a small change.");
  });

  test("curly double quotes become straight when the original used none", () => {
    expect(matchQuotes('She said "no".', "She said “no”.")).toBe('She said "no".');
  });

  test("leaves the rewrite alone when the original used typographic quotes", () => {
    const original = "It’s a small change.";
    const improved = "It’s a minor change.";
    expect(matchQuotes(original, improved)).toBe(improved);
  });

  test("leaves text without any quotes alone", () => {
    expect(matchQuotes("Hola mundo.", "Hola, mundo.")).toBe("Hola, mundo.");
  });

  test("does not touch other characters", () => {
    expect(matchQuotes("Ayer fui al médico.", "Ayer fui al médico — sí.")).toBe("Ayer fui al médico — sí.");
  });
});

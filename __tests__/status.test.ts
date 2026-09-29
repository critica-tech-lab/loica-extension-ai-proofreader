import { test, expect, describe } from "bun:test";
import { shortMessage } from "../status";

describe("shortMessage", () => {
  test("leaves a short message alone", () => {
    expect(shortMessage("The AI server is busy.")).toBe("The AI server is busy.");
  });

  test("keeps only the first sentence", () => {
    expect(shortMessage("The AI server is busy. Try again in a minute.")).toBe("The AI server is busy.");
  });

  test("cuts a long message with an ellipsis", () => {
    const out = shortMessage("x".repeat(300), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });

  test("falls back to a generic text for empty input", () => {
    expect(shortMessage("")).toBe("Something went wrong");
    expect(shortMessage(undefined)).toBe("Something went wrong");
  });
});

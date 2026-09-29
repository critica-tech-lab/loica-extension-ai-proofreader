import { test, expect, describe } from "bun:test";
import { detectLang } from "../lang";

describe("detectLang", () => {
  test("English", () => {
    expect(detectLang("We reviewed the proposal and agreed on the next steps.")).toBe("en");
  });

  test("Spanish", () => {
    expect(detectLang("El documento se sincroniza en tiempo real entre todos los usuarios.")).toBe("es");
  });

  test("misspelled text keeps its language", () => {
    expect(detectLang("Ella tambien vino a la fiesta.")).toBe("es");
    expect(detectLang("Their going to publish the article tomorow.")).toBe("en");
  });

  test("too little signal gives null", () => {
    expect(detectLang("OK.")).toBeNull();
    expect(detectLang("")).toBeNull();
  });
});

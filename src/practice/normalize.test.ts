import { describe, expect, it } from "vitest";

import { normalizeSentence } from "./normalize.ts";

describe("normalizeSentence", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeSentence("  Mitä  sinulle kuuluu? ")).toBe(
      normalizeSentence("mitä sinulle kuuluu"),
    );
  });

  it("keeps Finnish letters distinct", () => {
    expect(normalizeSentence("Äiti syö.")).toBe("äiti syö");
    expect(normalizeSentence("tuli")).not.toBe(normalizeSentence("tuuli"));
  });
});

import { describe, expect, it } from "vitest";

import type { PracticeItem, PracticeMode } from "../src/domain/model.ts";
import { acceptUpcoming, keepCurrent } from "./practiceQueue.ts";

const item = (n: number, mode: PracticeMode): PracticeItem =>
  ({
    audioUrl: `/audio/${n}`,
    english: `Sentence ${n}`,
    mode,
    sentenceId: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
  }) as PracticeItem;

describe("acceptUpcoming", () => {
  it("takes new sentences of the page's mode only", () => {
    const current = item(1, "intermediate");
    const answered = new Set([item(2, "beginner").sentenceId]);
    const result = acceptUpcoming(
      [current],
      [
        current,
        item(2, "beginner"),
        item(3, "beginner"),
        item(3, "beginner"),
        item(4, "beginner"),
      ],
      { answered, mode: "beginner" },
    );
    expect(result.accepted.map((i) => i.english)).toEqual([
      "Sentence 3",
      "Sentence 4",
    ]);
    // The current sentence repeated by the server is from the old mode.
    expect(result.otherMode).toBe(true);
  });

  it("reports nothing unusual when every sentence matches", () => {
    const result = acceptUpcoming([], [item(1, "beginner")], {
      answered: new Set(),
      mode: "beginner",
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.otherMode).toBe(false);
  });

  it("rejects sentences left over from another mode", () => {
    const result = acceptUpcoming(
      [],
      [item(1, "intermediate"), item(2, "intermediate")],
      { answered: new Set(), mode: "beginner" },
    );
    expect(result.accepted).toEqual([]);
    expect(result.otherMode).toBe(true);
  });
});

describe("keepCurrent", () => {
  it("keeps the sentence being heard and drops the prefetched ones", () => {
    const queue = [item(1, "intermediate"), item(2, "intermediate")];
    const { kept, dropped } = keepCurrent(queue);
    expect(kept).toEqual([queue[0]]);
    expect(dropped).toEqual([queue[1]]);
    expect(keepCurrent([])).toEqual({ dropped: [], kept: [] });
  });
});

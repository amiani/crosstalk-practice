import { describe, expect, it } from "vitest";

import type {
  PracticeItem,
  PracticeMode,
  PracticeTrack,
} from "../src/domain/model.ts";
import {
  holdForReserve,
  MAX_HOLD_MS,
  RESUME_RESERVE,
  acceptUpcoming,
  inStream,
  keepCurrent,
  sameStream,
} from "./practiceQueue.ts";
import type { PracticeStream } from "./practiceQueue.ts";

const item = (n: number, mode: PracticeMode | null): PracticeItem =>
  ({
    audioUrl: `/audio/${n}`,
    english: `Sentence ${n}`,
    mode,
    sentenceId: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
    track: mode === null ? "curriculum" : "crosstalk",
  }) as PracticeItem;

const crosstalk = (mode: PracticeMode): PracticeStream => ({
  mode,
  track: "crosstalk",
});
const curriculum = (mode: PracticeMode = "beginner"): PracticeStream => ({
  mode,
  track: "curriculum",
});

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
      { answered, capacity: 3, stream: crosstalk("beginner") },
    );
    expect(result.accepted.map((i) => i.english)).toEqual([
      "Sentence 3",
      "Sentence 4",
    ]);
    // The current sentence repeated by the server is from the old mode.
    expect(result.otherStream).toBe(true);
  });

  it("reports nothing unusual when every sentence matches", () => {
    const result = acceptUpcoming([], [item(1, "beginner")], {
      answered: new Set(),
      stream: crosstalk("beginner"),
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.otherStream).toBe(false);
  });

  it("rejects sentences left over from another mode", () => {
    const result = acceptUpcoming(
      [],
      [item(1, "intermediate"), item(2, "intermediate")],
      { answered: new Set(), stream: crosstalk("beginner") },
    );
    expect(result.accepted).toEqual([]);
    expect(result.otherStream).toBe(true);
  });

  it("keeps the queue to the current sentence and one prefetched", () => {
    const items = [item(1, null), item(2, null), item(3, null)];
    const empty = acceptUpcoming([], items, {
      answered: new Set(),
      stream: curriculum(),
    });
    expect(empty.accepted.map((i) => i.english)).toEqual([
      "Sentence 1",
      "Sentence 2",
    ]);
    const one = acceptUpcoming([item(1, null)], items, {
      answered: new Set(),
      stream: curriculum(),
    });
    expect(one.accepted.map((i) => i.english)).toEqual(["Sentence 2"]);
    const full = acceptUpcoming([item(1, null), item(2, null)], items, {
      answered: new Set(),
      stream: curriculum(),
    });
    expect(full.accepted).toEqual([]);
    expect(full.otherStream).toBe(false);
  });

  it("serves curriculum sentences whatever the page's mode", () => {
    const result = acceptUpcoming([], [item(1, null)], {
      answered: new Set(),
      stream: curriculum("intermediate"),
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.otherStream).toBe(false);
  });

  it("reports sentences of the other track", () => {
    const toCurriculum = acceptUpcoming([], [item(1, "beginner")], {
      answered: new Set(),
      stream: curriculum("beginner"),
    });
    expect(toCurriculum.accepted).toEqual([]);
    expect(toCurriculum.otherStream).toBe(true);

    const toCrosstalk = acceptUpcoming(
      [],
      [item(2, null), item(3, "beginner")],
      {
        answered: new Set(),
        stream: crosstalk("beginner"),
      },
    );
    expect(toCrosstalk.accepted.map((i) => i.english)).toEqual(["Sentence 3"]);
    expect(toCrosstalk.otherStream).toBe(true);
  });

  it("does not take a curriculum sentence already answered here", () => {
    const result = acceptUpcoming([], [item(1, null), item(2, null)], {
      answered: new Set([item(1, null).sentenceId]),
      stream: curriculum(),
    });
    expect(result.accepted.map((i) => i.english)).toEqual(["Sentence 2"]);
  });
});

describe("streams", () => {
  it("matches items by track, and crosstalk items by mode too", () => {
    expect(inStream(item(1, null), curriculum("intermediate"))).toBe(true);
    expect(inStream(item(1, "beginner"), crosstalk("beginner"))).toBe(true);
    expect(inStream(item(1, "beginner"), crosstalk("intermediate"))).toBe(
      false,
    );
    expect(inStream(item(1, "beginner"), curriculum("beginner"))).toBe(false);
    expect(inStream(item(1, null), crosstalk("beginner"))).toBe(false);
  });

  it("treats a mode change within the curriculum as no change", () => {
    const tracks: ReadonlyArray<PracticeTrack> = ["crosstalk", "curriculum"];
    expect(sameStream(curriculum("beginner"), curriculum("intermediate"))).toBe(
      true,
    );
    expect(sameStream(crosstalk("beginner"), crosstalk("intermediate"))).toBe(
      false,
    );
    for (const track of tracks) {
      expect(
        sameStream({ mode: "beginner", track }, { mode: "beginner", track }),
      ).toBe(true);
    }
    expect(sameStream(crosstalk("beginner"), curriculum("beginner"))).toBe(
      false,
    );
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

describe("holdForReserve", () => {
  it("waits for a small reserve after running dry, but not forever", () => {
    expect(holdForReserve(0, 0)).toBe(false);
    expect(holdForReserve(1, 0)).toBe(true);
    expect(holdForReserve(RESUME_RESERVE - 1, 1000)).toBe(true);
    expect(holdForReserve(RESUME_RESERVE, 0)).toBe(false);
    expect(holdForReserve(1, MAX_HOLD_MS)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { deriveEvidence } from "./evidence.ts";
import type { StoredEvent } from "./evidence.ts";

const response = {
  presentationId: "p1",
  translationRevealed: false,
  understood: true,
};
const log = (
  presentationId: string,
  ...types: ReadonlyArray<string>
): Array<StoredEvent> =>
  types.map((eventType, sequence) => ({ eventType, presentationId, sequence }));

describe("deriveEvidence", () => {
  it("is complete once the responding presentation's log has no gaps", () => {
    const events = log(
      "p1",
      "Presented",
      "PlayRequested",
      "PlaybackStarted",
      "Responded",
    );
    expect(deriveEvidence(response, events)).toEqual({
      startedPlaybacks: 1,
      traceComplete: true,
      translationRevealed: false,
      understood: true,
      usable: true,
    });
  });

  it("stays incomplete while events are missing or before they arrive", () => {
    expect(deriveEvidence(response, []).traceComplete).toBe(false);
    expect(deriveEvidence(response, []).usable).toBeNull();
    const gap = log("p1", "Presented", "PlaybackStarted", "Responded").filter(
      (event) => event.sequence !== 1,
    );
    expect(deriveEvidence(response, gap).traceComplete).toBe(false);
  });

  it("counts a reveal in an earlier presentation of the same sentence", () => {
    const events = [
      ...log("p0", "Presented", "TranslationRevealed"),
      ...log("p1", "Presented", "PlaybackStarted", "Responded"),
    ];
    const evidence = deriveEvidence(response, events);
    expect(evidence.translationRevealed).toBe(true);
    expect(evidence.traceComplete).toBe(true);
  });

  it("marks a response without any playback as not a fair listen", () => {
    const events = log(
      "p1",
      "Presented",
      "PlayRequested",
      "PlaybackFailed",
      "Responded",
    );
    expect(deriveEvidence(response, events).usable).toBe(false);
  });

  it("does not depend on arrival order", () => {
    const events = log(
      "p1",
      "Presented",
      "PlaybackStarted",
      "PlaybackStarted",
      "Responded",
    );
    expect(deriveEvidence(response, events.toReversed())).toEqual(
      deriveEvidence(response, events),
    );
  });
});

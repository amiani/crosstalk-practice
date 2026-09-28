/**
 * Turns the stored response and presentation events of one curriculum
 * sentence into the facts the learner model needs. Pure, so the same inputs
 * always give the same evidence however late or out of order events arrive.
 */

export interface StoredResponse {
  readonly presentationId: string | null;
  readonly translationRevealed: boolean;
  readonly understood: boolean;
}

export interface StoredEvent {
  readonly eventType: string;
  readonly presentationId: string;
  readonly sequence: number;
}

export interface DerivedEvidence {
  readonly startedPlaybacks: number;
  readonly traceComplete: boolean;
  /** Revealed in the response or in any presentation, including earlier ones. */
  readonly translationRevealed: boolean;
  readonly understood: boolean;
  /** Whether there was a fair listen: null while the trace is incomplete. */
  readonly usable: boolean | null;
}

/**
 * Complete means every presentation's events run from 0 without gaps and the
 * responding presentation logged its response: nothing that could change
 * the classification is still missing (as far as the log can tell).
 */
export const deriveEvidence = (
  response: StoredResponse,
  events: ReadonlyArray<StoredEvent>,
): DerivedEvidence => {
  const sequences = new Map<string, Array<number>>();
  if (response.presentationId !== null) {
    sequences.set(response.presentationId, []);
  }
  for (const event of events) {
    const list = sequences.get(event.presentationId) ?? [];
    list.push(event.sequence);
    sequences.set(event.presentationId, list);
  }
  const contiguous = [...sequences.values()].every((list) =>
    list
      .toSorted((a, b) => a - b)
      .every((sequence, index) => sequence === index),
  );
  const responded =
    response.presentationId !== null &&
    events.some(
      (event) =>
        event.presentationId === response.presentationId &&
        event.eventType === "Responded",
    );
  const traceComplete = contiguous && responded;
  const startedPlaybacks = events.filter(
    (event) => event.eventType === "PlaybackStarted",
  ).length;
  let usable: boolean | null = null;
  if (startedPlaybacks > 0) {
    usable = true;
  } else if (traceComplete) {
    usable = false;
  }
  return {
    startedPlaybacks,
    traceComplete,
    translationRevealed:
      response.translationRevealed ||
      events.some((event) => event.eventType === "TranslationRevealed"),
    understood: response.understood,
    usable,
  };
};

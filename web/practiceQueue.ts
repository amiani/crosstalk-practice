import type { PracticeItem, PracticeMode } from "../src/domain/model.ts";

/**
 * Which of the server's upcoming sentences may join the local queue: new
 * ones, not answered here already, generated in the mode the page is in.
 * `otherMode` reports sentences of another mode, which means the server's
 * mode changed without this page knowing (e.g. in another tab).
 */
export const acceptUpcoming = (
  queue: ReadonlyArray<PracticeItem>,
  items: ReadonlyArray<PracticeItem>,
  options: {
    readonly mode: PracticeMode;
    readonly answered: ReadonlySet<string>;
  },
): {
  readonly accepted: ReadonlyArray<PracticeItem>;
  readonly otherMode: boolean;
} => {
  const known = new Set<string>(queue.map((item) => item.sentenceId));
  const accepted: Array<PracticeItem> = [];
  let otherMode = false;
  for (const item of items) {
    if (item.mode !== options.mode) {
      otherMode = true;
      continue;
    }
    if (known.has(item.sentenceId) || options.answered.has(item.sentenceId)) {
      continue;
    }
    known.add(item.sentenceId);
    accepted.push(item);
  }
  return { accepted, otherMode };
};

/**
 * Splits the queue when the mode changes: the current sentence stays (it is
 * already being heard, whatever its mode) and prefetched ones are dropped.
 */
export const keepCurrent = (
  queue: ReadonlyArray<PracticeItem>,
): {
  readonly kept: Array<PracticeItem>;
  readonly dropped: ReadonlyArray<PracticeItem>;
} => ({ dropped: queue.slice(1), kept: queue.slice(0, 1) });

import type {
  PracticeItem,
  PracticeMode,
  PracticeTrack,
} from "../src/domain/model.ts";

/**
 * Which sentences the page is serving: a track, and for crosstalk the mode
 * they are generated in. Curriculum sentences have no mode.
 */
export interface PracticeStream {
  readonly track: PracticeTrack;
  readonly mode: PracticeMode;
}

/** At most the sentence being heard plus one prefetched. */
export const QUEUE_CAPACITY = 2;

/**
 * After running dry, curriculum practice waits until this many sentences
 * are ready, so one wait buys several sentences rather than one.
 */
export const RESUME_RESERVE = 3;
/** The longest the page holds back ready sentences to build that reserve. */
export const MAX_HOLD_MS = 45_000;

/** Whether to keep waiting for a reserve although some sentences are ready. */
export const holdForReserve = (ready: number, dryForMs: number): boolean =>
  ready > 0 && ready < RESUME_RESERVE && dryForMs < MAX_HOLD_MS;

export const inStream = (item: PracticeItem, stream: PracticeStream): boolean =>
  item.track === stream.track &&
  (stream.track === "curriculum" || item.mode === stream.mode);

/** Whether switching from `a` to `b` changes which sentences are served. */
export const sameStream = (a: PracticeStream, b: PracticeStream): boolean =>
  a.track === b.track && (a.track === "curriculum" || a.mode === b.mode);

/**
 * Which of the server's upcoming sentences may join the local queue: new
 * ones, not answered here already, of the page's stream, up to the queue's
 * capacity. `otherStream` reports sentences of another stream, which means
 * the server's track or mode changed without this page knowing (e.g. in
 * another tab).
 */
export const acceptUpcoming = (
  queue: ReadonlyArray<PracticeItem>,
  items: ReadonlyArray<PracticeItem>,
  options: {
    readonly stream: PracticeStream;
    readonly answered: ReadonlySet<string>;
    readonly capacity?: number;
  },
): {
  readonly accepted: ReadonlyArray<PracticeItem>;
  readonly otherStream: boolean;
} => {
  const room = (options.capacity ?? QUEUE_CAPACITY) - queue.length;
  const known = new Set<string>(queue.map((item) => item.sentenceId));
  const accepted: Array<PracticeItem> = [];
  let otherStream = false;
  for (const item of items) {
    if (!inStream(item, options.stream)) {
      otherStream = true;
      continue;
    }
    if (
      accepted.length >= room ||
      known.has(item.sentenceId) ||
      options.answered.has(item.sentenceId)
    ) {
      continue;
    }
    known.add(item.sentenceId);
    accepted.push(item);
  }
  return { accepted, otherStream };
};

/**
 * Splits the queue when the stream changes: the current sentence stays (it
 * is already being heard, whatever its stream) and prefetched ones are
 * dropped.
 */
export const keepCurrent = (
  queue: ReadonlyArray<PracticeItem>,
): {
  readonly kept: Array<PracticeItem>;
  readonly dropped: ReadonlyArray<PracticeItem>;
} => ({ dropped: queue.slice(1), kept: queue.slice(0, 1) });

/* eslint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-date, effecttsgo/global-timers -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared schemas. */
import { Predicate, Schema } from "effect";

import { PracticeResponse, SentenceId } from "../src/domain/model.ts";
import type { SendOutcome } from "./presentationLog.ts";

/**
 * Delivers curriculum answers durably. An answer is evidence of what the
 * learner understood, so it is kept in `localStorage` (one entry per
 * sentence) until the server stores it, surviving lost connections and
 * reloads. The server accepts an identical resend, so retrying is safe.
 *
 * Storage is re-read before every change, so tabs sharing it do not
 * overwrite each other's pending answers.
 */

export type SendResponse = (
  sentenceId: SentenceId,
  response: PracticeResponse,
  options: { readonly keepalive: boolean },
) => Promise<SendOutcome>;

export interface ResponseOutboxOptions {
  readonly send: SendResponse;
  readonly storage?:
    | Pick<Storage, "getItem" | "setItem" | "removeItem">
    | undefined;
  /** Wall-clock epoch milliseconds, as from Date.now(). */
  readonly now?: (() => number) | undefined;
  /** Timer for background delivery; tests pass one that never fires. */
  readonly setTimer?: ((run: () => void, ms: number) => void) | undefined;
}

const PendingResponse = Schema.Struct({
  /** When the learner answered, in client epoch milliseconds. */
  answeredAt: Schema.Finite,
  response: PracticeResponse,
  sentenceId: SentenceId,
});
type PendingResponse = typeof PendingResponse.Type;

const PendingResponses = Schema.fromJsonString(
  Schema.Record(Schema.String, PendingResponse),
);
const decodePending = Schema.decodeUnknownOption(PendingResponses);
const encodePending = Schema.encodeSync(PendingResponses);

type Entries = Record<string, PendingResponse>;

const STORAGE_KEY = "crosstalk-practice.curriculum-responses.v1";
const RETRY_BASE_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
/** Keepalive requests share a small budget (~64 KiB); answers are tiny. */
const MAX_KEEPALIVE_SENDS = 10;

const sameEntry = (a: PendingResponse, b: PendingResponse): boolean =>
  a.sentenceId === b.sentenceId &&
  a.answeredAt === b.answeredAt &&
  a.response.presentationId === b.response.presentationId;

const oldestFirst = (entries: Entries): Array<PendingResponse> =>
  Object.values(entries).toSorted((a, b) => a.answeredAt - b.answeredAt);

/**
 * How a delivery went, from the HTTP response. Network trouble, timeouts,
 * rate limits and server errors are worth retrying; so is a 404 that is not
 * the API's own SentenceNotFound, which most likely comes from a server that
 * predates the route. Anything else (a conflicting answer, a deleted
 * sentence, an invalid request) will not get better.
 */
export const deliveryOutcome = async (
  response: Pick<Response, "ok" | "status" | "json">,
): Promise<SendOutcome> => {
  if (response.ok) {
    return "accepted";
  }
  if (response.status === 404) {
    const body: unknown = await response.json().catch(() => undefined);
    const gone = Predicate.isObject(body) && body._tag === "SentenceNotFound";
    return gone ? "rejected" : "retry";
  }
  const transient =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500;
  return transient ? "retry" : "rejected";
};

export class ResponseOutbox {
  private memory: Entries;
  private flushing: Promise<void> | undefined;
  private timerSet = false;
  private failures = 0;
  /** False once a write failed; memory is then the only copy to trust. */
  private storageWorks = true;
  private readonly send: SendResponse;
  private readonly storage: ResponseOutboxOptions["storage"];
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => void;

  public constructor(options: ResponseOutboxOptions) {
    this.send = options.send;
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.memory = {};
    this.memory = this.read();
  }

  /** Number of answers not yet stored by the server. */
  public get size(): number {
    return Object.keys(this.read()).length;
  }

  /** When the oldest undelivered answer was given, if any. */
  public oldestPendingAt(): number | undefined {
    return oldestFirst(this.read())[0]?.answeredAt;
  }

  /**
   * Keeps an answer until the server stores it and starts delivering it.
   * A sentence is answered once; a second answer to it is ignored.
   */
  public enqueue(sentenceId: SentenceId, response: PracticeResponse): void {
    const entries = this.read();
    if (entries[sentenceId] !== undefined) {
      return;
    }
    entries[sentenceId] = { answeredAt: this.now(), response, sentenceId };
    this.write(entries);
    void this.flush();
  }

  /**
   * Delivers every pending answer, oldest first; resolves when done or
   * stalled. A flush already running picks up answers added meanwhile.
   */
  public async flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /**
   * Best effort for a page that may be about to disappear: sends pending
   * answers with keepalive so the browser finishes them after unload.
   * Anything unconfirmed stays stored and is resent on the next visit.
   */
  public flushOnExit(): void {
    for (const entry of oldestFirst(this.read()).slice(
      0,
      MAX_KEEPALIVE_SENDS,
    )) {
      void this.deliver(entry, true);
    }
  }

  private async drain(): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      const entry = oldestFirst(this.read()).find(
        (candidate) => !tried.has(candidate.sentenceId),
      );
      if (entry === undefined) {
        return;
      }
      tried.add(entry.sentenceId);
      const outcome = await this.deliver(entry, false);
      if (outcome === "retry") {
        this.failures += 1;
        this.schedule(
          Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_MS * 2 ** this.failures),
        );
        return;
      }
      this.failures = 0;
    }
  }

  /** Sends one answer and forgets it unless it should be retried. */
  private async deliver(
    entry: PendingResponse,
    keepalive: boolean,
  ): Promise<SendOutcome> {
    let outcome: SendOutcome;
    try {
      outcome = await this.send(entry.sentenceId, entry.response, {
        keepalive,
      });
    } catch {
      outcome = "retry";
    }
    if (outcome === "rejected") {
      console.warn("Dropped an answer the server refused", entry.sentenceId);
    }
    if (outcome !== "retry") {
      const entries = this.read();
      const stored = entries[entry.sentenceId];
      if (stored !== undefined && sameEntry(stored, entry)) {
        this.write(
          Object.fromEntries(
            Object.entries(entries).filter(([id]) => id !== entry.sentenceId),
          ),
        );
      }
    }
    return outcome;
  }

  private schedule(ms: number): void {
    if (this.timerSet) {
      return;
    }
    this.timerSet = true;
    this.setTimer(() => {
      this.timerSet = false;
      void this.flush();
    }, ms);
  }

  /** The pending answers, from storage when it works, else from memory. */
  private read(): Entries {
    let stored: string | null;
    try {
      if (this.storage === undefined || !this.storageWorks) {
        return { ...this.memory };
      }
      stored = this.storage.getItem(STORAGE_KEY);
    } catch {
      return { ...this.memory };
    }
    if (stored === null) {
      this.memory = {};
      return {};
    }
    const decoded = decodePending(stored);
    this.memory = decoded._tag === "Some" ? { ...decoded.value } : {};
    return { ...this.memory };
  }

  private write(entries: Entries): void {
    this.memory = entries;
    try {
      if (Object.keys(entries).length === 0) {
        this.storage?.removeItem(STORAGE_KEY);
      } else {
        this.storage?.setItem(STORAGE_KEY, encodePending(entries));
      }
    } catch {
      // Storage full or unavailable: delivery still works while the page lives.
      this.storageWorks = false;
    }
  }
}

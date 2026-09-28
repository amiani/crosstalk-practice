/* eslint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-date, effecttsgo/global-timers -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared schemas. */
import { Schema } from "effect";

import {
  MAX_PRESENTATION_EVENTS_PER_BATCH,
  PresentationEvent,
  PresentationId,
  SentenceId,
} from "../src/domain/model.ts";
import type { PresentationEventDetail } from "../src/domain/model.ts";

/**
 * Records what happens while a sentence is on screen and delivers it to the
 * server in the background. Events are kept in `localStorage` until the
 * server accepts them, so a lost connection or a reload does not drop them;
 * the server ignores resent event ids.
 */

/** A random v4 UUID; crypto.randomUUID is missing on plain-HTTP LAN pages. */
export const randomUuid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ]
    .map((part) => part.join(""))
    .join("-");
};

const PendingEvent = Schema.Struct({
  event: PresentationEvent,
  presentationId: PresentationId,
  sentenceId: SentenceId,
});
type PendingEvent = typeof PendingEvent.Type;

const PendingEvents = Schema.fromJsonString(Schema.Array(PendingEvent));
const decodePending = Schema.decodeUnknownOption(PendingEvents);
const encodePending = Schema.encodeSync(PendingEvents);

/** What became of a delivery attempt. */
export type SendOutcome =
  /** Stored (or already stored). */
  | "accepted"
  /** Refused for good (unknown sentence, conflict, invalid); drop it. */
  | "rejected"
  /** Network or server trouble; try again later. */
  | "retry";

export type SendEvents = (
  sentenceId: SentenceId,
  presentationId: PresentationId,
  events: ReadonlyArray<PresentationEvent>,
  options: { readonly keepalive: boolean },
) => Promise<SendOutcome>;

export interface Clock {
  /** Monotonic milliseconds, as from performance.now(). */
  readonly monotonic: () => number;
  /** Wall-clock epoch milliseconds, as from Date.now(). */
  readonly epoch: () => number;
}

export interface OutboxOptions {
  readonly send: SendEvents;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  readonly clock?: Clock | undefined;
  /** Timer for background delivery; tests pass one that never fires. */
  readonly setTimer?: ((run: () => void, ms: number) => void) | undefined;
}

const STORAGE_KEY = "crosstalk-practice.presentation-events.v1";
/** Beyond this many undelivered events the oldest are dropped. */
const MAX_PENDING = 5000;
const FLUSH_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
/** Keepalive requests share a small budget (~64 KiB), so send only a few. */
const MAX_KEEPALIVE_BATCHES = 2;

const browserClock: Clock = {
  epoch: () => Date.now(),
  monotonic: () => performance.now(),
};

const sameTarget = (a: PendingEvent, b: PendingEvent) =>
  a.sentenceId === b.sentenceId && a.presentationId === b.presentationId;

/** The oldest pending events of the first presentation in the list. */
const batchFrom = (
  entries: ReadonlyArray<PendingEvent>,
): ReadonlyArray<PendingEvent> => {
  const first = entries[0];
  if (first === undefined) {
    return [];
  }
  return entries
    .filter((entry) => sameTarget(entry, first))
    .slice(0, MAX_PRESENTATION_EVENTS_PER_BATCH);
};

export class PresentationOutbox {
  public readonly clock: Clock;
  private pending: Array<PendingEvent>;
  private flushing: Promise<void> | undefined;
  private flushAgain = false;
  private timerSet = false;
  private failures = 0;
  private readonly send: SendEvents;
  private readonly storage: OutboxOptions["storage"];
  private readonly setTimer: (run: () => void, ms: number) => void;

  public constructor(options: OutboxOptions) {
    this.send = options.send;
    this.storage = options.storage;
    this.clock = options.clock ?? browserClock;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.pending = this.load();
  }

  /** Number of undelivered events. */
  public get size(): number {
    return this.pending.length;
  }

  /** Starts a presentation of the sentence, with a fresh id and clock. */
  public begin(sentenceId: SentenceId): Presentation {
    return new Presentation(this, sentenceId);
  }

  /** Queues an event for delivery; used by Presentation.record. */
  public enqueue(entry: PendingEvent): void {
    this.pending.push(entry);
    if (this.pending.length > MAX_PENDING) {
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
    this.save();
    this.schedule(FLUSH_DELAY_MS);
  }

  /** Delivers everything pending, in order; resolves when done or stalled. */
  public async flush(): Promise<void> {
    if (this.flushing !== undefined) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      if (this.flushAgain) {
        this.flushAgain = false;
        void this.flush();
      }
    });
    return this.flushing;
  }

  /**
   * Best effort for a page that may be about to disappear: sends the oldest
   * batches with keepalive so the browser finishes them after unload.
   * Anything unconfirmed stays stored and is resent on the next visit.
   */
  public flushOnExit(): void {
    let rest: ReadonlyArray<PendingEvent> = this.pending;
    for (let sent = 0; sent < MAX_KEEPALIVE_BATCHES; sent += 1) {
      const batch = batchFrom(rest);
      if (batch.length === 0) {
        return;
      }
      const taken = new Set(batch);
      rest = rest.filter((entry) => !taken.has(entry));
      void this.deliver(batch, true);
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const batch = batchFrom(this.pending);
      if (batch.length === 0) {
        return;
      }
      const outcome = await this.deliver(batch, false);
      if (outcome === "retry") {
        this.failures += 1;
        this.schedule(
          Math.min(MAX_RETRY_DELAY_MS, FLUSH_DELAY_MS * 2 ** this.failures),
        );
        return;
      }
      this.failures = 0;
    }
  }

  /** Sends one batch and forgets it unless it should be retried. */
  private async deliver(
    batch: ReadonlyArray<PendingEvent>,
    keepalive: boolean,
  ): Promise<SendOutcome> {
    const first = batch[0];
    if (first === undefined) {
      return "accepted";
    }
    let outcome: SendOutcome;
    try {
      outcome = await this.send(
        first.sentenceId,
        first.presentationId,
        batch.map((entry) => entry.event),
        { keepalive },
      );
    } catch {
      outcome = "retry";
    }
    if (outcome === "rejected") {
      console.warn(
        "Dropped presentation events the server refused",
        first.presentationId,
        batch.length,
      );
    }
    if (outcome !== "retry") {
      const done = new Set(batch);
      this.pending = this.pending.filter((entry) => !done.has(entry));
      this.save();
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

  private load(): Array<PendingEvent> {
    let stored: string | null = null;
    try {
      stored = this.storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return [];
    }
    if (stored === null) {
      return [];
    }
    const decoded = decodePending(stored);
    return decoded._tag === "Some" ? [...decoded.value] : [];
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, encodePending(this.pending));
    } catch {
      // Storage full or unavailable: delivery still works while the page lives.
    }
  }
}

/** One showing of a sentence; its events are numbered and timed from 0. */
export class Presentation {
  public readonly id: PresentationId;
  public readonly sentenceId: SentenceId;
  private readonly outbox: PresentationOutbox;
  private readonly startedAt: number;
  private sequence = 0;

  public constructor(outbox: PresentationOutbox, sentenceId: SentenceId) {
    this.outbox = outbox;
    this.sentenceId = sentenceId;
    this.id = PresentationId.make(randomUuid());
    this.startedAt = outbox.clock.monotonic();
  }

  public record(detail: PresentationEventDetail): void {
    const { clock } = this.outbox;
    this.outbox.enqueue({
      event: {
        clientElapsedMs: Math.max(0, clock.monotonic() - this.startedAt),
        clientEpochMs: clock.epoch(),
        detail,
        eventId: randomUuid(),
        sequence: this.sequence,
      },
      presentationId: this.id,
      sentenceId: this.sentenceId,
    });
    this.sequence += 1;
  }
}

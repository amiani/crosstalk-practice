/* eslint-disable effecttsgo/async-function -- The outbox is plain promise code, like the rest of the browser client. */
import { describe, expect, it } from "vitest";

import { SentenceId } from "../src/domain/model.ts";
import type { PresentationEvent, PresentationId } from "../src/domain/model.ts";
import { PresentationOutbox, randomUuid } from "./presentationLog.ts";
import type { SendOutcome } from "./presentationLog.ts";

const sentenceA = SentenceId.make("10000000-0000-4000-8000-000000000001");
const sentenceB = SentenceId.make("10000000-0000-4000-8000-000000000002");

interface Sent {
  readonly sentenceId: string;
  readonly presentationId: PresentationId;
  readonly events: ReadonlyArray<PresentationEvent>;
  readonly keepalive: boolean;
}

/** An outbox over in-memory storage whose server answers from a script. */
const setup = (outcomes: Array<SendOutcome> = []) => {
  const sent: Array<Sent> = [];
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  let now = 1000;
  const clock = { epoch: () => 1_780_000_000_000 + now, monotonic: () => now };
  const make = () =>
    new PresentationOutbox({
      clock,
      send: async (sentenceId, presentationId, events, { keepalive }) => {
        sent.push({ events, keepalive, presentationId, sentenceId });
        return await Promise.resolve(outcomes.shift() ?? "accepted");
      },
      setTimer: () => {},
      storage,
    });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    make,
    outcomes,
    sent,
  };
};

describe("randomUuid", () => {
  it("makes distinct v4 UUIDs", () => {
    const ids = new Set(Array.from({ length: 100 }, randomUuid));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("PresentationOutbox", () => {
  it("numbers and times events from the start of the presentation", async () => {
    const { advance, make, sent } = setup();
    const outbox = make();
    advance(500);
    const presentation = outbox.begin(sentenceA);
    presentation.record({ _tag: "Presented", autoplay: true, visible: true });
    advance(1200);
    presentation.record({ _tag: "TranslationRevealed" });
    await outbox.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.presentationId).toBe(presentation.id);
    expect(
      sent[0]?.events.map((e) => [
        e.sequence,
        e.clientElapsedMs,
        e.detail._tag,
      ]),
    ).toEqual([
      [0, 0, "Presented"],
      [1, 1200, "TranslationRevealed"],
    ]);
    expect(outbox.size).toBe(0);
  });

  it("keeps events through failures and a reload, then resends the same ids", async () => {
    const { make, outcomes, sent } = setup(["retry"]);
    const outbox = make();
    const presentation = outbox.begin(sentenceA);
    presentation.record({ _tag: "Presented", autoplay: false, visible: true });
    await outbox.flush();
    expect(outbox.size).toBe(1);

    const reloaded = make();
    expect(reloaded.size).toBe(1);
    outcomes.push("accepted");
    await reloaded.flush();
    expect(reloaded.size).toBe(0);
    expect(sent.map((s) => s.events[0]?.eventId)).toEqual([
      sent[0]?.events[0]?.eventId,
      sent[0]?.events[0]?.eventId,
    ]);
    expect(make().size).toBe(0);
  });

  it("sends each presentation separately and drops refused batches", async () => {
    const { make, sent } = setup(["rejected", "accepted"]);
    const outbox = make();
    const first = outbox.begin(sentenceA);
    const second = outbox.begin(sentenceB);
    first.record({ _tag: "Presented", autoplay: true, visible: true });
    second.record({ _tag: "Presented", autoplay: true, visible: true });
    first.record({ _tag: "Responded", understood: false });
    await outbox.flush();

    expect(sent.map((s) => [s.presentationId, s.events.length])).toEqual([
      [first.id, 2],
      [second.id, 1],
    ]);
    expect(outbox.size).toBe(0);
  });

  it("splits large backlogs into bounded batches", async () => {
    const { make, sent } = setup();
    const outbox = make();
    const presentation = outbox.begin(sentenceA);
    for (let i = 0; i < 150; i += 1) {
      presentation.record({ _tag: "VisibilityChanged", visible: i % 2 === 0 });
    }
    await outbox.flush();
    expect(sent.map((s) => s.events.length)).toEqual([100, 50]);
    expect(sent[1]?.events[0]?.sequence).toBe(100);
  });

  it("sends with keepalive when the page may be going away", async () => {
    const { make, sent } = setup();
    const outbox = make();
    outbox
      .begin(sentenceA)
      .record({ _tag: "VisibilityChanged", visible: false });
    outbox.flushOnExit();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((s) => s.keepalive)).toEqual([true]);
    expect(outbox.size).toBe(0);
  });
});

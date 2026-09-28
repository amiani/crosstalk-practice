/* eslint-disable effecttsgo/async-function -- The outbox is plain promise code, like the rest of the browser client. */
import { describe, expect, it } from "vitest";

import { PresentationId, SentenceId } from "../src/domain/model.ts";
import type { PracticeResponse } from "../src/domain/model.ts";
import type { SendOutcome } from "./presentationLog.ts";
import { deliveryOutcome, ResponseOutbox } from "./responseOutbox.ts";

const sentenceA = SentenceId.make("20000000-0000-4000-8000-000000000001");
const sentenceB = SentenceId.make("20000000-0000-4000-8000-000000000002");

const answer = (n: number, understood = true): PracticeResponse => ({
  presentationId: PresentationId.make(
    `30000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
  ),
  replayCount: 0,
  translationRevealed: false,
  understood,
});

interface Sent {
  readonly sentenceId: string;
  readonly response: PracticeResponse;
  readonly keepalive: boolean;
}

/** Outboxes over shared in-memory storage whose server answers from a script. */
const setup = (outcomes: Array<SendOutcome | "throw"> = []) => {
  const sent: Array<Sent> = [];
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const timers: Array<{ readonly run: () => void; readonly ms: number }> = [];
  let now = 1_780_000_000_000;
  const make = () =>
    new ResponseOutbox({
      now: () => now,
      send: async (sentenceId, response, { keepalive }) => {
        sent.push({ keepalive, response, sentenceId });
        const outcome = outcomes.shift() ?? "accepted";
        if (outcome === "throw") {
          throw new Error("network down");
        }
        return await Promise.resolve(outcome);
      },
      setTimer: (run, ms) => void timers.push({ ms, run }),
      storage,
    });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    make,
    sent,
    store,
    timers,
  };
};

describe("ResponseOutbox", () => {
  it("sends an answer once and forgets it when stored", async () => {
    const { make, sent, store } = setup();
    const outbox = make();
    outbox.enqueue(sentenceA, answer(1));
    await outbox.flush();
    expect(sent).toEqual([
      { keepalive: false, response: answer(1), sentenceId: sentenceA },
    ]);
    expect(outbox.size).toBe(0);
    expect(store.size).toBe(0);
    await outbox.flush();
    expect(sent).toHaveLength(1);
  });

  it("keeps answers across reloads until they are delivered", async () => {
    const { make, sent } = setup(["retry"]);
    const first = make();
    first.enqueue(sentenceA, answer(1));
    await first.flush();
    expect(first.size).toBe(1);

    const reloaded = make();
    expect(reloaded.size).toBe(1);
    await reloaded.flush();
    expect(reloaded.size).toBe(0);
    expect(sent.map((s) => s.sentenceId)).toEqual([sentenceA, sentenceA]);
    expect(sent[1]?.response).toEqual(answer(1));
  });

  it("retries with growing, capped delays and resets after success", async () => {
    const { make, timers } = setup([
      "retry",
      "throw",
      "retry",
      "retry",
      "retry",
      "retry",
      "retry",
    ]);
    const outbox = make();
    outbox.enqueue(sentenceA, answer(1));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await outbox.flush();
      const timer = timers.shift();
      if (timer === undefined) {
        break;
      }
      expect(timer.ms).toBe(Math.min(30_000, 1000 * 2 ** (attempt + 1)));
      timer.run();
    }
    await outbox.flush();
    expect(outbox.size).toBe(0);
    expect(timers).toEqual([]);
  });

  it("drops answers the server refuses for good", async () => {
    const { make, sent } = setup(["rejected", "accepted"]);
    const outbox = make();
    outbox.enqueue(sentenceA, answer(1));
    outbox.enqueue(sentenceB, answer(2));
    await outbox.flush();
    expect(sent.map((s) => s.sentenceId)).toEqual([sentenceA, sentenceB]);
    expect(outbox.size).toBe(0);
  });

  it("delivers the oldest answer first and ignores a second answer", async () => {
    const { advance, make, sent } = setup(["retry"]);
    const outbox = make();
    outbox.enqueue(sentenceA, answer(1));
    await outbox.flush();
    advance(10);
    outbox.enqueue(sentenceB, answer(2));
    outbox.enqueue(sentenceA, answer(3, false));
    await outbox.flush();
    expect(sent.map((s) => [s.sentenceId, s.response.presentationId])).toEqual([
      [sentenceA, answer(1).presentationId],
      [sentenceA, answer(1).presentationId],
      [sentenceB, answer(2).presentationId],
    ]);
  });

  it("does not lose answers another tab added meanwhile", async () => {
    const { make } = setup(["retry"]);
    const tabA = make();
    const tabB = make();
    tabA.enqueue(sentenceA, answer(1));
    await tabA.flush();
    tabB.enqueue(sentenceB, answer(2));
    expect(tabA.size).toBe(2);
    await tabB.flush();
    expect(tabA.size).toBe(0);
  });

  it("sends pending answers with keepalive when the page may close", async () => {
    const { make, sent } = setup(["retry", "accepted"]);
    const outbox = make();
    outbox.enqueue(sentenceA, answer(1));
    await outbox.flush();
    outbox.flushOnExit();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.at(-1)).toEqual({
      keepalive: true,
      response: answer(1),
      sentenceId: sentenceA,
    });
    expect(outbox.size).toBe(0);
  });

  it("reports how long the oldest answer has waited", async () => {
    const { advance, make } = setup(["retry"]);
    const outbox = make();
    expect(outbox.oldestPendingAt()).toBeUndefined();
    outbox.enqueue(sentenceA, answer(1));
    const answeredAt = outbox.oldestPendingAt();
    await outbox.flush();
    advance(5000);
    outbox.enqueue(sentenceB, answer(2));
    expect(outbox.oldestPendingAt()).toBe(answeredAt);
  });

  it("works from memory when storage is unavailable", async () => {
    const outcomes: Array<SendOutcome> = ["retry"];
    const outbox = new ResponseOutbox({
      send: async () => Promise.resolve(outcomes.shift() ?? "accepted"),
      setTimer: () => {},
      storage: {
        getItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    outbox.enqueue(sentenceA, answer(1));
    await outbox.flush();
    expect(outbox.size).toBe(1);
    await outbox.flush();
    expect(outbox.size).toBe(0);
  });

  it("ignores corrupt storage", () => {
    const store = new Map([
      ["crosstalk-practice.curriculum-responses.v1", "{not json"],
    ]);
    const outbox = new ResponseOutbox({
      send: async () => Promise.resolve("accepted"),
      setTimer: () => {},
      storage: {
        getItem: (key) => store.get(key) ?? null,
        removeItem: (key) => void store.delete(key),
        setItem: (key, value) => void store.set(key, value),
      },
    });
    expect(outbox.size).toBe(0);
  });
});

describe("deliveryOutcome", () => {
  const response = (status: number, body?: unknown) => ({
    json: async () =>
      body === undefined
        ? Promise.reject(new Error("no body"))
        : Promise.resolve(body),
    ok: status >= 200 && status < 300,
    status,
  });

  it("accepts success, including an identical resend", async () => {
    expect(await deliveryOutcome(response(204))).toBe("accepted");
  });

  it("retries transient failures", async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(await deliveryOutcome(response(status))).toBe("retry");
    }
  });

  it("retries a 404 from a route the server does not know", async () => {
    expect(await deliveryOutcome(response(404))).toBe("retry");
    expect(
      await deliveryOutcome(response(404, { _tag: "RouteNotFound" })),
    ).toBe("retry");
  });

  it("drops answers to deleted sentences and conflicting answers", async () => {
    expect(
      await deliveryOutcome(
        response(404, { _tag: "SentenceNotFound", sentenceId: sentenceA }),
      ),
    ).toBe("rejected");
    expect(
      await deliveryOutcome(
        response(409, { _tag: "AlreadyAnswered", sentenceId: sentenceA }),
      ),
    ).toBe("rejected");
    expect(await deliveryOutcome(response(400))).toBe("rejected");
  });
});

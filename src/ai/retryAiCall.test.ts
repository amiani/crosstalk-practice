import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref, Schedule } from "effect";
import { AiError } from "effect/unstable/ai";

import { retryAiCall } from "./retryAiCall.ts";

const emptyResponse = AiError.make({
  method: "generateObject",
  module: "LanguageModel",
  reason: new AiError.StructuredOutputError({
    description: "No text content in response",
    responseText: "",
  }),
});

const badKey = AiError.make({
  method: "generateObject",
  module: "LanguageModel",
  reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
});

/** Fails with the given errors in turn, then succeeds with the attempt count. */
const flaky = (
  attempts: Ref.Ref<number>,
  failures: ReadonlyArray<AiError.AiError>,
) =>
  Ref.updateAndGet(attempts, (n) => n + 1).pipe(
    Effect.flatMap((attempt) => {
      const failure = failures[attempt - 1];
      return failure === undefined
        ? Effect.succeed(attempt)
        : Effect.fail(failure);
    }),
  );

const fast = { schedule: Schedule.spaced("1 millis") };

describe("retryAiCall", () => {
  it.live("retries an empty structured response", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const result = yield* flaky(attempts, [emptyResponse]).pipe(
        retryAiCall("test", fast),
      );
      assert.strictEqual(result, 2);
    }),
  );

  it.live("gives up after the allowed attempts", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const error = yield* flaky(attempts, [
        emptyResponse,
        emptyResponse,
        emptyResponse,
      ]).pipe(retryAiCall("test", fast), Effect.flip);
      assert.strictEqual(error.reason._tag, "StructuredOutputError");
      assert.strictEqual(yield* Ref.get(attempts), 3);
    }),
  );

  it.live("does not retry errors a new attempt cannot fix", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      yield* flaky(attempts, [badKey]).pipe(
        retryAiCall("test", fast),
        Effect.flip,
      );
      assert.strictEqual(yield* Ref.get(attempts), 1);
    }),
  );
});

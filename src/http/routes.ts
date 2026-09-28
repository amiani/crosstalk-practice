import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { Api } from "../api/Api.ts";
import { SentenceId, UNSPECIFIED_PRACTICE_MODE } from "../domain/model.ts";
import { Practice } from "../practice/Practice.ts";

/**
 * Storage failures are not something the learner can act on: they surface
 * as 500s (and in the logs), not as part of the API's error vocabulary.
 */
const orDieOnStore = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, { readonly _tag: "PracticeStoreError" }> =>
        error._tag === "PracticeStoreError",
      Effect.die,
    ),
  );

const sessionHandlers = HttpApiBuilder.group(
  Api,
  "session",
  Effect.fn(function* (handlers) {
    const practice = yield* Practice;
    return handlers.handleAll({
      current: () => orDieOnStore(practice.view),
      reset: () => orDieOnStore(practice.reset),
      retry: () => orDieOnStore(practice.retry),
      setMode: ({ payload }) => orDieOnStore(practice.setMode(payload.mode)),
      upload: ({ payload }) =>
        orDieOnStore(
          practice.start(
            payload.recording,
            payload.mode ?? UNSPECIFIED_PRACTICE_MODE,
          ),
        ),
    });
  }),
);

const practiceHandlers = HttpApiBuilder.group(
  Api,
  "practice",
  Effect.fn(function* (handlers) {
    const practice = yield* Practice;
    return handlers.handleAll({
      recordPresentationEvents: ({ params, payload }) =>
        orDieOnStore(
          practice.recordPresentationEvents(
            params.sentenceId,
            params.presentationId,
            payload.events,
          ),
        ),
      respond: ({ params, payload }) =>
        orDieOnStore(practice.respond(params.sentenceId, payload)),
      upcoming: () => orDieOnStore(practice.upcoming),
    });
  }),
);

const decodeSentenceId = Schema.decodeUnknownEffect(SentenceId);

/** Sentence audio, served with whatever content type the synthesizer chose. */
const audioRoute = HttpRouter.add(
  "GET",
  "/api/sentences/:sentenceId/audio",
  Effect.gen(function* () {
    const practice = yield* Practice;
    const params = yield* HttpRouter.params;
    const sentenceId = yield* decodeSentenceId(params.sentenceId).pipe(
      Effect.option,
    );
    if (Option.isNone(sentenceId)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const audio = yield* practice.audio(sentenceId.value).pipe(Effect.orDie);
    return Option.match(audio, {
      onNone: () => HttpServerResponse.empty({ status: 404 }),
      onSome: (speech) =>
        HttpServerResponse.uint8Array(speech.bytes, {
          contentType: speech.mimeType,
          headers: { "cache-control": "private, max-age=31536000, immutable" },
        }),
    });
  }),
);

export const apiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide([sessionHandlers, practiceHandlers]),
  ),
  audioRoute,
);

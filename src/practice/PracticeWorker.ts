import { Context, Effect, FileSystem, Layer, Queue, Result } from "effect";

import type { SessionId, SessionProfile } from "../domain/model.ts";
import { SpeechSynthesizer } from "../speech/SpeechSynthesizer.ts";
import { Transcriber } from "../speech/Transcriber.ts";
import { normalizeSentence } from "./normalize.ts";
import { PracticeSettings } from "./PracticeSettings.ts";
import { PracticeStore } from "./PracticeStore.ts";
import type { PracticeStoreError, SessionRecord } from "./PracticeStore.ts";
import { SentenceAuthor } from "./SentenceAuthor.ts";

/** Consecutive generation rounds that add nothing before a pass gives up. */
const MAX_UNPRODUCTIVE_ROUNDS = 3;

/**
 * Background work for the active session. Each pass reconciles stored state
 * with what should exist: transcribe an uploaded recording, profile the
 * transcript, then keep a small buffer of voiced, unanswered sentences.
 * Everything is derived from the database, so a restart simply resumes.
 */
export class PracticeWorker extends Context.Service<
  PracticeWorker,
  {
    readonly runPass: Effect.Effect<void, PracticeStoreError>;
    /** Asks for a pass soon, e.g. after an upload or an answer. */
    readonly wake: Effect.Effect<void>;
    /** Waits for a wake-up, or the idle interval as a safety net. */
    readonly waitForWork: Effect.Effect<void>;
  }
>()("crosstalk-practice/practice/PracticeWorker") {
  public static readonly layer = Layer.effect(
    PracticeWorker,
    Effect.gen(function* () {
      const store = yield* PracticeStore;
      const transcriber = yield* Transcriber;
      const author = yield* SentenceAuthor;
      const synthesizer = yield* SpeechSynthesizer;
      const settings = yield* PracticeSettings;
      const fs = yield* FileSystem.FileSystem;
      const signal = yield* Queue.sliding<void>(1);

      const transcribe = Effect.fn("PracticeWorker.transcribe")(function* (
        session: SessionRecord,
      ) {
        if (session.recordingPath === null) {
          return yield* store.fail(session.sessionId, "transcribing", {
            message:
              "The recording is no longer available. Start over with a new upload.",
            reason: "transcription_failed",
            retryable: false,
          });
        }
        const recordingPath = session.recordingPath;
        const result = yield* transcriber
          .transcribe({
            fileName: session.fileName,
            mimeType: session.recordingMimeType,
            path: recordingPath,
          })
          .pipe(Effect.result);
        if (Result.isFailure(result)) {
          yield* Effect.logError("Transcription failed", result.failure);
          return yield* store.fail(session.sessionId, "transcribing", {
            message: `Transcription failed: ${result.failure.message}`,
            reason: "transcription_failed",
            retryable: true,
          });
        }
        yield* store.saveTranscript(session.sessionId, result.success);
        yield* fs
          .remove(recordingPath)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not delete recording", error),
            ),
          );
      });

      const analyze = Effect.fn("PracticeWorker.analyze")(function* (
        session: SessionRecord,
      ) {
        if (session.transcript === null) {
          return yield* Effect.die("An analyzing session has no transcript");
        }
        const result = yield* author
          .profileSession(session.transcript)
          .pipe(Effect.result);
        if (Result.isFailure(result)) {
          yield* Effect.logError("Session analysis failed", result.failure);
          return yield* store.fail(session.sessionId, "analyzing", {
            message: `Analysis failed: ${result.failure.message}`,
            reason: "analysis_failed",
            retryable: true,
          });
        }
        const profile = result.success;
        if (profile.utterances.length < settings.minUtterances) {
          return yield* store.fail(session.sessionId, "analyzing", {
            message:
              `Only ${profile.utterances.length} clearly transcribed Finnish utterances were found ` +
              `(${profile.discardedSnippets} more were too unclear to use); at least ` +
              `${settings.minUtterances} are needed for reliable practice.`,
            reason: "insufficient_material",
            retryable: false,
          });
        }
        yield* store.saveProfile(session.sessionId, profile);
      });

      const voicePending = Effect.fn("PracticeWorker.voicePending")(function* (
        sessionId: SessionId,
      ) {
        const pending = yield* store.awaitingAudio(sessionId);
        yield* Effect.forEach(
          pending,
          (sentence) =>
            synthesizer.synthesize(sentence.finnish).pipe(
              Effect.flatMap((speech) =>
                store.saveAudio(sentence.sentenceId, speech),
              ),
              // Left without audio, the sentence is retried next pass.
              Effect.catchTag("SpeechSynthesisError", (error) =>
                Effect.logWarning("Speech synthesis failed", error),
              ),
            ),
          { concurrency: settings.synthesisConcurrency, discard: true },
        );
      });

      const replenish = Effect.fn("PracticeWorker.replenish")(function* (
        sessionId: SessionId,
        profile: SessionProfile,
      ) {
        yield* voicePending(sessionId);
        let unproductive = 0;
        while (unproductive < MAX_UNPRODUCTIVE_ROUNDS) {
          const unanswered = yield* store.unansweredCount(sessionId);
          if (unanswered >= settings.bufferSize) {
            return;
          }
          const recent = yield* store.recentSentences(
            sessionId,
            settings.recentSentences,
          );
          const struggles = yield* store.recentStruggles(
            sessionId,
            settings.struggleWindow,
          );
          const drafts = yield* author
            .writeSentences({
              count: settings.batchSize,
              profile,
              recent,
              struggles: struggles.slice(0, settings.maxStruggles),
            })
            .pipe(Effect.result);
          if (Result.isFailure(drafts)) {
            yield* Effect.logError(
              "Sentence generation failed",
              drafts.failure,
            );
            return;
          }
          const inserted = yield* store.insertSentences(
            sessionId,
            drafts.success
              .map((draft) => ({
                ...draft,
                normalized: normalizeSentence(draft.finnish),
              }))
              .filter((draft) => draft.normalized !== ""),
          );
          yield* Effect.logInfo("Generated practice sentences").pipe(
            Effect.annotateLogs({
              accepted: drafts.success.length,
              inserted,
              struggles: struggles.length,
            }),
          );
          unproductive = inserted === 0 ? unproductive + 1 : 0;
          yield* voicePending(sessionId);
        }
        yield* Effect.logWarning(
          "Generation produced no new sentences; will try again later",
        );
      });

      const runPass = Effect.fn("PracticeWorker.runPass")(function* () {
        // Each step moves the session forward (or fails it), so this ends.
        for (;;) {
          const current = yield* store.current;
          if (current._tag === "None") {
            return;
          }
          const session = current.value;
          switch (session.stage) {
            case "transcribing":
              yield* transcribe(session);
              continue;
            case "analyzing":
              yield* analyze(session);
              continue;
            case "ready":
              if (session.profile === null) {
                return yield* Effect.die("A ready session has no profile");
              }
              return yield* replenish(session.sessionId, session.profile);
            case "failed":
              return;
          }
        }
      });

      return PracticeWorker.of({
        runPass: runPass(),
        waitForWork: Queue.take(signal).pipe(
          Effect.timeoutOption("30 seconds"),
          Effect.asVoid,
        ),
        wake: Queue.offer(signal, undefined).pipe(Effect.asVoid),
      });
    }),
  );
}

/** Runs worker passes for the lifetime of the application. */
export const practiceWorkerLoop = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* PracticeWorker;
    yield* worker.runPass.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Practice worker pass failed", cause),
      ),
      Effect.andThen(worker.waitForWork),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);

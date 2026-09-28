import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Random,
} from "effect";

import { audioPath } from "../api/Api.ts";
import { RecordingConverter } from "../audio/RecordingConverter.ts";
import { Curriculum } from "../curriculum/Curriculum.ts";
import { CurriculumStore } from "../curriculum/CurriculumStore.ts";
import {
  NoActiveSession,
  NotRetryable,
  RecordingRejected,
  SessionAlreadyExists,
} from "../domain/model.ts";
import type {
  AlreadyAnswered,
  PracticeItem,
  PracticeMode,
  PracticeResponse,
  PracticeTrack,
  PresentationConflict,
  PresentationEvent,
  PresentationId,
  SentenceId,
  SentenceNotFound,
  SessionView,
} from "../domain/model.ts";
import type { SynthesizedSpeech } from "../speech/SpeechSynthesizer.ts";
import { PracticeSettings } from "./PracticeSettings.ts";
import { PracticeStore, PracticeStoreError } from "./PracticeStore.ts";
import type { SessionRecord } from "./PracticeStore.ts";
import { PracticeWorker } from "./PracticeWorker.ts";

const UPCOMING_LIMIT = 3;
/** Enough for the page to tell when a reserve of sentences is ready. */
const CURRICULUM_UPCOMING_LIMIT = 4;

/** An uploaded file, valid only for the duration of the upload request. */
export interface UploadedRecording {
  readonly path: string;
  readonly name: string;
}

/** The learner-facing operations; transport handlers stay thin over this. */
export class Practice extends Context.Service<
  Practice,
  {
    readonly view: Effect.Effect<SessionView, PracticeStoreError>;
    readonly start: (
      upload: UploadedRecording,
      mode: PracticeMode,
      track: PracticeTrack,
    ) => Effect.Effect<
      SessionView,
      SessionAlreadyExists | RecordingRejected | PracticeStoreError
    >;
    /**
     * Selects the mode future sentences are generated and served in. The
     * sentence the learner is hearing, and all history, stay as they are.
     */
    readonly setMode: (
      mode: PracticeMode,
    ) => Effect.Effect<SessionView, NoActiveSession | PracticeStoreError>;
    /**
     * Selects the track future sentences are served from; like a mode
     * change, it applies after the current sentence.
     */
    readonly setTrack: (
      track: PracticeTrack,
    ) => Effect.Effect<SessionView, NoActiveSession | PracticeStoreError>;
    readonly retry: Effect.Effect<
      SessionView,
      NoActiveSession | NotRetryable | PracticeStoreError
    >;
    /** Start over: deletes the session and all curriculum progress. */
    readonly reset: Effect.Effect<void, PracticeStoreError>;
    /**
     * Deletes the session to make way for a new recording, keeping the
     * curriculum evidence gathered so far.
     */
    readonly replaceRecording: Effect.Effect<void, PracticeStoreError>;
    readonly upcoming: Effect.Effect<
      ReadonlyArray<PracticeItem>,
      NoActiveSession | PracticeStoreError
    >;
    readonly curriculumUpcoming: Effect.Effect<
      ReadonlyArray<PracticeItem>,
      NoActiveSession | PracticeStoreError
    >;
    readonly respond: (
      sentenceId: SentenceId,
      response: PracticeResponse,
    ) => Effect.Effect<
      void,
      | SentenceNotFound
      | AlreadyAnswered
      | PresentationConflict
      | PracticeStoreError
    >;
    /** Records a curriculum response; resending the same one succeeds. */
    readonly curriculumRespond: (
      sentenceId: SentenceId,
      response: PracticeResponse,
    ) => Effect.Effect<
      void,
      | SentenceNotFound
      | AlreadyAnswered
      | PresentationConflict
      | PracticeStoreError
    >;
    /**
     * Appends to a presentation's interaction log. For curriculum sentences
     * it refines their evidence; it never affects crosstalk practice.
     */
    readonly recordPresentationEvents: (
      sentenceId: SentenceId,
      presentationId: PresentationId,
      events: ReadonlyArray<PresentationEvent>,
    ) => Effect.Effect<
      void,
      SentenceNotFound | PresentationConflict | PracticeStoreError
    >;
    readonly audio: (
      sentenceId: SentenceId,
    ) => Effect.Effect<Option.Option<SynthesizedSpeech>, PracticeStoreError>;
  }
>()("crosstalk-practice/practice/Practice") {
  public static readonly layer = Layer.effect(
    Practice,
    Effect.gen(function* () {
      const store = yield* PracticeStore;
      const curriculumStore = yield* CurriculumStore;
      const curriculum = yield* Curriculum;
      const worker = yield* PracticeWorker;
      const converter = yield* RecordingConverter;
      const settings = yield* PracticeSettings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const recordingsDir = path.resolve(settings.dataDir, "recordings");

      const viewOf = Effect.fn("Practice.viewOf")(function* (
        session: SessionRecord,
      ) {
        const summary = {
          createdAt: session.createdAt,
          fileName: session.fileName,
          mode: session.mode,
          sessionId: session.sessionId,
          track: session.track,
        };
        switch (session.stage) {
          case "transcribing":
          case "analyzing":
            return {
              _tag: "Preparing",
              ...summary,
              stage: session.stage,
            } satisfies SessionView;
          case "failed":
            return {
              _tag: "Failed",
              ...summary,
              failure: session.failure ?? {
                message: "Preparation failed",
                reason: "analysis_failed",
                retryable: true,
              },
            } satisfies SessionView;
          case "ready": {
            const stats = yield* store.stats(session.sessionId);
            // Nothing has ever been voiced yet: still preparing, as far as
            // the learner is concerned.
            if (stats.answered === 0 && stats.buffered === 0) {
              return {
                _tag: "Preparing",
                ...summary,
                stage: "generating",
              } satisfies SessionView;
            }
            return {
              _tag: "Ready",
              ...summary,
              stats,
              summary: session.profile?.summary ?? "",
              topics: session.profile?.topics ?? [],
            } satisfies SessionView;
          }
        }
      });

      const view = store.current.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed<SessionView>({ _tag: "NoSession" }),
            onSome: viewOf,
          }),
        ),
        Effect.withSpan("Practice.view"),
      );

      const platformError = (cause: unknown) =>
        new PracticeStoreError({ cause });

      const start = Effect.fn("Practice.start")(
        function* (
          upload: UploadedRecording,
          mode: PracticeMode,
          track: PracticeTrack,
        ) {
          if (Option.isSome(yield* store.current)) {
            return yield* new SessionAlreadyExists();
          }
          const seconds = yield* converter.probe(upload.path);
          if (seconds > settings.maxRecordingSeconds) {
            return yield* new RecordingRejected({
              message: `The recording is ${Math.round(seconds / 60)} minutes long; the limit is ${Math.round(settings.maxRecordingSeconds / 60)} minutes.`,
            });
          }
          yield* fs
            .makeDirectory(recordingsDir, { recursive: true })
            .pipe(Effect.mapError(platformError));
          const millis = yield* Clock.currentTimeMillis;
          const nonce = yield* Random.nextIntBetween(0, 2 ** 31);
          const target = path.join(
            recordingsDir,
            `${millis.toString(36)}-${nonce.toString(36)}`,
          );
          // The upload's temporary file disappears with the request; the
          // converted copy lives until transcription succeeds.
          const converted = yield* converter.convert(upload.path, target);
          const session = yield* store
            .create({
              fileName: upload.name,
              mode,
              recordingMimeType: converted.mimeType,
              recordingPath: converted.path,
              recordingSeconds: converted.seconds,
              track,
            })
            .pipe(
              Effect.tapError(() =>
                fs.remove(converted.path).pipe(Effect.ignore),
              ),
            );
          yield* worker.wake;
          return yield* viewOf(session);
        },
        Effect.catchTag("RecordingUnusable", (error) =>
          Effect.fail(new RecordingRejected({ message: error.message })),
        ),
      );

      const retry = Effect.gen(function* () {
        const current = yield* store.current;
        if (Option.isNone(current)) {
          return yield* new NoActiveSession();
        }
        const session = current.value;
        if (session.stage !== "failed" || session.failure?.retryable !== true) {
          return yield* new NotRetryable();
        }
        yield* store.resume(session.sessionId);
        yield* worker.wake;
        return yield* view;
      }).pipe(Effect.withSpan("Practice.retry"));

      const setMode = Effect.fn("Practice.setMode")(function* (
        mode: PracticeMode,
      ) {
        const current = yield* store.current;
        if (Option.isNone(current)) {
          return yield* new NoActiveSession();
        }
        if (current.value.mode !== mode) {
          yield* store.setMode(current.value.sessionId, mode);
          yield* worker.wake;
        }
        return yield* view;
      });

      const setTrack = Effect.fn("Practice.setTrack")(function* (
        track: PracticeTrack,
      ) {
        const current = yield* store.current;
        if (Option.isNone(current)) {
          return yield* new NoActiveSession();
        }
        if (current.value.track !== track) {
          yield* store.setTrack(current.value.sessionId, track);
          yield* worker.wake;
        }
        return yield* view;
      });

      const removeSession = Effect.gen(function* () {
        const removed = yield* store.remove;
        if (Option.isSome(removed) && removed.value.recordingPath !== null) {
          yield* fs.remove(removed.value.recordingPath).pipe(Effect.ignore);
        }
      });

      const reset = Effect.gen(function* () {
        yield* removeSession;
        yield* curriculumStore.clear;
      }).pipe(Effect.withSpan("Practice.reset"));

      const replaceRecording = removeSession.pipe(
        Effect.withSpan("Practice.replaceRecording"),
      );

      const upcoming = Effect.gen(function* () {
        const current = yield* store.current;
        if (Option.isNone(current) || current.value.stage !== "ready") {
          return yield* new NoActiveSession();
        }
        const sentences = yield* store.upcoming(
          current.value.sessionId,
          current.value.mode,
          UPCOMING_LIMIT,
        );
        return sentences.map((sentence): PracticeItem => ({
          audioUrl: audioPath(sentence.sentenceId),
          english: sentence.english,
          mode: sentence.mode,
          sentenceId: sentence.sentenceId,
          track: sentence.track,
        }));
      }).pipe(Effect.withSpan("Practice.upcoming"));

      const curriculumUpcoming = Effect.gen(function* () {
        const current = yield* store.current;
        if (Option.isNone(current) || current.value.stage !== "ready") {
          return yield* new NoActiveSession();
        }
        return yield* curriculum.upcoming(
          current.value.sessionId,
          CURRICULUM_UPCOMING_LIMIT,
        );
      }).pipe(Effect.withSpan("Practice.curriculumUpcoming"));

      const respond = Effect.fn("Practice.respond")(function* (
        sentenceId: SentenceId,
        response: PracticeResponse,
      ) {
        yield* store.respond(sentenceId, response);
        yield* worker.wake;
      });

      const curriculumRespond = Effect.fn("Practice.curriculumRespond")(
        function* (sentenceId: SentenceId, response: PracticeResponse) {
          yield* curriculumStore.respond(sentenceId, response);
          yield* worker.wake;
        },
      );

      const recordPresentationEvents = Effect.fn(
        "Practice.recordPresentationEvents",
      )(function* (
        sentenceId: SentenceId,
        presentationId: PresentationId,
        events: ReadonlyArray<PresentationEvent>,
      ) {
        yield* store.recordPresentationEvents(
          sentenceId,
          presentationId,
          events,
        );
        if (yield* curriculumStore.refreshEvidence(sentenceId)) {
          yield* worker.wake;
        }
      });

      return Practice.of({
        audio: store.audio,
        curriculumRespond,
        curriculumUpcoming,
        recordPresentationEvents,
        replaceRecording,
        reset,
        respond,
        retry,
        setMode,
        setTrack,
        start,
        upcoming,
        view,
      });
    }),
  );
}

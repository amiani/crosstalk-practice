import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import {
  Config,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { HttpRouter } from "effect/unstable/http";

import { RecordingConverter } from "../audio/RecordingConverter.ts";
import { Curriculum } from "../curriculum/Curriculum.ts";
import { CurriculumAuthor } from "../curriculum/CurriculumAuthor.ts";
import type { CurriculumBrief } from "../curriculum/CurriculumAuthor.ts";
import { CurriculumStore } from "../curriculum/CurriculumStore.ts";
import { curriculumStorePostgres } from "../curriculum/CurriculumStorePostgres.ts";
import { clientLayer, migrations, migrationSteps } from "../db/Database.ts";
import { PresentationId, SentenceId } from "../domain/model.ts";
import type {
  PracticeMode,
  PracticeTrack,
  PresentationEvent,
  SessionProfile,
} from "../domain/model.ts";
import { apiRoutes } from "../http/routes.ts";
import { SpeechSynthesizer } from "../speech/SpeechSynthesizer.ts";
import { Transcriber, TranscriptionError } from "../speech/Transcriber.ts";
import { Practice } from "./Practice.ts";
import { PracticeSettings } from "./PracticeSettings.ts";
import { practiceStorePostgres } from "./PracticeStorePostgres.ts";
import { PracticeWorker } from "./PracticeWorker.ts";
import { AuthoringError, SentenceAuthor } from "./SentenceAuthor.ts";
import type { SentenceBrief } from "./SentenceAuthor.ts";

/**
 * The whole practice lifecycle against real PostgreSQL, with the speech and
 * language providers replaced by deterministic fakes. Opt in with
 * CROSSTALK_TEST_DATABASE_URL; the suite recreates that database's schema.
 */

// eslint-disable-next-line effecttsgo/process-env -- Vitest registration happens before any Effect runs.
const url = process.env.CROSSTALK_TEST_DATABASE_URL;

const unknownSentence = Schema.decodeSync(SentenceId)(
  "00000000-0000-4000-8000-000000000000",
);

let uuidCounter = 0;
/** Distinct, valid v4 UUIDs for test data. */
const nextUuid = () => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
};
const newPresentation = () => PresentationId.make(nextUuid());

const event = (
  sequence: number,
  detail: PresentationEvent["detail"],
  eventId = nextUuid(),
): PresentationEvent => ({
  clientElapsedMs: sequence * 250,
  clientEpochMs: 1_780_000_000_000 + sequence * 250,
  detail,
  eventId,
  sequence,
});

/** Knobs and observations for the fake providers. */
class Fakes extends Context.Service<
  Fakes,
  {
    readonly utterances: Ref.Ref<number>;
    readonly recordingSeconds: Ref.Ref<number>;
    readonly failTranscription: Ref.Ref<boolean>;
    readonly briefs: Ref.Ref<ReadonlyArray<SentenceBrief>>;
    readonly written: Ref.Ref<number>;
    /** Runs once, in the middle of the next sentence-writing call. */
    readonly duringWrite: Ref.Ref<Effect.Effect<void> | undefined>;
    readonly curriculumBriefs: Ref.Ref<ReadonlyArray<CurriculumBrief>>;
    readonly failCurriculum: Ref.Ref<boolean>;
    /** Distinct sentences each curriculum writing passes. */
    readonly curriculumDrafts: Ref.Ref<number>;
    /** When set, curriculum writes wait until this many run at once. */
    readonly concurrentWrites: Ref.Ref<
      | {
          readonly count: number;
          readonly open: Deferred.Deferred<void>;
          readonly started: Ref.Ref<number>;
        }
      | undefined
    >;
  }
>()("test/Fakes") {}

const fakesLayer = Layer.effect(
  Fakes,
  Effect.gen(function* () {
    return Fakes.of({
      briefs: yield* Ref.make<ReadonlyArray<SentenceBrief>>([]),
      concurrentWrites: yield* Ref.make<
        | {
            readonly count: number;
            readonly open: Deferred.Deferred<void>;
            readonly started: Ref.Ref<number>;
          }
        | undefined
      >(undefined),
      curriculumBriefs: yield* Ref.make<ReadonlyArray<CurriculumBrief>>([]),
      curriculumDrafts: yield* Ref.make(1),
      duringWrite: yield* Ref.make<Effect.Effect<void> | undefined>(undefined),
      failCurriculum: yield* Ref.make(false),
      failTranscription: yield* Ref.make(false),
      recordingSeconds: yield* Ref.make(120),
      utterances: yield* Ref.make(3),
      written: yield* Ref.make(0),
    });
  }),
);

const profileWith = (utterances: number): SessionProfile => ({
  constructions: [{ description: "Question with -ko", example: "Onko?" }],
  discardedSnippets: 1,
  register: "Spoken Finnish",
  summary: "Talking about coffee",
  topics: ["coffee"],
  utterances: Array.from({ length: utterances }, (_, index) => ({
    english: `Sentence ${index}`,
    finnish: `Lause ${index}`,
  })),
  vocabulary: [{ english: "coffee", heard: "kahvia", lemma: "kahvi" }],
});

const providersLayer = Layer.mergeAll(
  Layer.effect(
    Transcriber,
    Effect.gen(function* () {
      const fakes = yield* Fakes;
      return Transcriber.of({
        transcribe: () =>
          Ref.get(fakes.failTranscription).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(new TranscriptionError({ message: "offline" }))
                : Effect.succeed({
                    source: "fake",
                    text: "Juotko kahvia? Yes, I do.",
                    turns: [
                      { speaker: "spk_1", text: "Juotko kahvia?" },
                      { speaker: "spk_2", text: "Yes, I do." },
                    ],
                  }),
            ),
          ),
      });
    }),
  ),
  Layer.effect(
    SentenceAuthor,
    Effect.gen(function* () {
      const fakes = yield* Fakes;
      return SentenceAuthor.of({
        profileSession: () =>
          Ref.get(fakes.utterances).pipe(Effect.map(profileWith)),
        writeSentences: (brief) =>
          Effect.gen(function* () {
            yield* Ref.update(fakes.briefs, (briefs) => [...briefs, brief]);
            const during = yield* Ref.getAndSet(fakes.duringWrite, undefined);
            if (during !== undefined) {
              yield* during;
            }
            const start = yield* Ref.getAndUpdate(
              fakes.written,
              (n) => n + brief.count,
            );
            return [
              // Always offered again; stored only once.
              { english: "Hello!", finnish: "Hei!", variationOf: null },
              ...Array.from({ length: brief.count - 1 }, (_, index) => ({
                english: `Coffee number ${start + index}`,
                finnish: `Kahvi numero ${start + index}`,
                variationOf: brief.struggles[0]?.sentenceId ?? null,
              })),
            ];
          }),
      });
    }),
  ),
  Layer.effect(
    CurriculumAuthor,
    Effect.gen(function* () {
      const fakes = yield* Fakes;
      return CurriculumAuthor.of({
        write: (brief) =>
          Effect.gen(function* () {
            const briefs = yield* Ref.updateAndGet(
              fakes.curriculumBriefs,
              (all) => [...all, brief],
            );
            if (yield* Ref.get(fakes.failCurriculum)) {
              return yield* new AuthoringError({
                message: "offline",
                operation: "fake",
              });
            }
            const n = briefs.length;
            const gate = yield* Ref.get(fakes.concurrentWrites);
            if (gate !== undefined) {
              // Waits until `gate.count` writes are under way at once.
              const started = yield* Ref.updateAndGet(
                gate.started,
                (k) => k + 1,
              );
              if (started >= gate.count) {
                yield* Deferred.succeed(gate.open, undefined);
              }
              yield* Deferred.await(gate.open);
            }
            const realisation = brief.target.realisations[0]?.form ?? "";
            const drafts = yield* Ref.get(fakes.curriculumDrafts);
            return {
              accepted: Array.from({ length: drafts }, (_, k) => ({
                contentWords: ["kahvi", `sana${n}_${k}`],
                english: `${brief.target.id} example ${n} ${k}`,
                finnish: `${brief.target.id} esimerkki ${n} ${k}`,
                realisation,
                reviewNote: "",
              })),
              rejected: [{ finnish: "Huono lause.", reason: "stilted" }],
            };
          }),
      });
    }),
  ),
  Layer.succeed(
    SpeechSynthesizer,
    SpeechSynthesizer.of({
      synthesize: () =>
        Effect.succeed({
          bytes: new Uint8Array([82, 73, 70, 70]),
          mimeType: "audio/wav",
        }),
    }),
  ),
  Layer.effect(
    RecordingConverter,
    Effect.gen(function* () {
      const fakes = yield* Fakes;
      const fs = yield* FileSystem.FileSystem;
      return RecordingConverter.of({
        convert: (input, output) =>
          fs.copyFile(input, `${output}.mp3`).pipe(
            Effect.orDie,
            Effect.andThen(Ref.get(fakes.recordingSeconds)),
            Effect.map((seconds) => ({
              mimeType: "audio/mp3",
              path: `${output}.mp3`,
              seconds,
            })),
          ),
        probe: () => Ref.get(fakes.recordingSeconds),
        split: (input) => Effect.succeed([input]),
      });
    }),
  ),
);

const resetSchema = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`DROP SCHEMA public CASCADE`;
    yield* sql`CREATE SCHEMA public`;
  }),
);

const database = migrations.pipe(
  Layer.provide(resetSchema),
  Layer.provideMerge(
    clientLayer(Config.succeed(Redacted.make(url ?? "postgres://unused"))),
  ),
);

const settingsLayer = Layer.effect(
  PracticeSettings,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped();
    return PracticeSettings.of({
      ...PracticeSettings.defaults,
      batchSize: 3,
      bufferSize: 4,
      dataDir,
      minUtterances: 2,
    });
  }),
);

const TestLayer = Practice.layer.pipe(
  Layer.provideMerge(PracticeWorker.layer),
  Layer.provideMerge(Curriculum.layer),
  Layer.provideMerge(curriculumStorePostgres),
  Layer.provideMerge(practiceStorePostgres),
  Layer.provideMerge(providersLayer),
  Layer.provideMerge(fakesLayer),
  Layer.provideMerge(settingsLayer),
  Layer.provideMerge(database),
  Layer.provideMerge(NodeServices.layer),
);

const SentenceRows = Schema.Array(
  Schema.Struct({
    finnish: Schema.String,
    variationOf: Schema.NullOr(Schema.String),
  }),
);

const GenerationRows = Schema.Array(
  Schema.Struct({
    answered: Schema.Boolean,
    generationMode: Schema.String,
    generationPolicy: Schema.String,
    voiced: Schema.Boolean,
  }),
);

/** How every stored sentence was generated, oldest first. */
const generationRows = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  return yield* sql`
    SELECT
      s.generation_mode,
      s.generation_policy,
      s.audio IS NOT NULL AS voiced,
      r.sentence_id IS NOT NULL AS answered
    FROM
      practice_sentences s
      LEFT JOIN practice_responses r ON r.sentence_id = s.sentence_id
    ORDER BY
      s.position
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GenerationRows)));
});

/** A fresh session from a throwaway upload, with every fake reset. */
const freshSession = Effect.fnUntraced(function* (
  mode: PracticeMode = "intermediate",
  track: PracticeTrack = "crosstalk",
) {
  const practice = yield* Practice;
  const fakes = yield* Fakes;
  const fs = yield* FileSystem.FileSystem;
  yield* practice.reset;
  yield* Ref.set(fakes.utterances, 3);
  yield* Ref.set(fakes.recordingSeconds, 120);
  yield* Ref.set(fakes.failTranscription, false);
  yield* Ref.set(fakes.briefs, []);
  yield* Ref.set(fakes.duringWrite, undefined);
  yield* Ref.set(fakes.curriculumBriefs, []);
  yield* Ref.set(fakes.failCurriculum, false);
  yield* Ref.set(fakes.curriculumDrafts, 1);
  yield* Ref.set(fakes.concurrentWrites, undefined);
  const path = yield* fs.makeTempFileScoped();
  yield* fs.writeFileString(path, "not really audio");
  return yield* practice.start({ name: "session.m4a", path }, mode, track);
});

describe.skipIf(url === undefined)("Practice (PostgreSQL)", () => {
  it.layer(TestLayer, { timeout: 30000 })((it) => {
    it.effect("prepares an upload into voiced, deduplicated sentences", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const sql = yield* PgClient.PgClient;
          const settings = yield* PracticeSettings;
          const fs = yield* FileSystem.FileSystem;

          const started = yield* freshSession();
          assert.strictEqual(started._tag, "Preparing");
          const recordings = yield* fs.readDirectory(
            `${settings.dataDir}/recordings`,
          );
          assert.strictEqual(recordings.length, 1);

          yield* worker.settle;

          const view = yield* practice.view;
          assert.strictEqual(view._tag, "Ready");
          if (view._tag === "Ready") {
            assert.isAtLeast(view.stats.buffered, settings.bufferSize);
            assert.deepStrictEqual(view.topics, ["coffee"]);
          }
          // The source audio is gone once transcribed.
          assert.deepStrictEqual(
            yield* fs.readDirectory(`${settings.dataDir}/recordings`),
            [],
          );

          const rows = yield* sql`
            SELECT
              finnish,
              variation_of
            FROM
              practice_sentences
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SentenceRows)));
          assert.strictEqual(
            rows.filter((row) => row.finnish === "Hei!").length,
            1,
          );

          const upcoming = yield* practice.upcoming;
          assert.strictEqual(upcoming.length, 3);
          const first = upcoming[0];
          assert.isDefined(first);
          assert.strictEqual(first.english, "Hello!");
          const audio = yield* practice.audio(first.sentenceId);
          assert.isTrue(Option.isSome(audio));
        }),
      ),
    );

    it.effect("steers generation toward sentences not understood", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;

          yield* freshSession();
          yield* worker.settle;
          const [missed, understood] = yield* practice.upcoming;
          assert.isDefined(missed);
          assert.isDefined(understood);
          const answer = { replayCount: 2, translationRevealed: true };
          yield* practice.respond(missed.sentenceId, {
            ...answer,
            presentationId: newPresentation(),
            understood: false,
          });
          yield* practice.respond(understood.sentenceId, {
            ...answer,
            presentationId: newPresentation(),
            understood: true,
          });

          const again = yield* practice
            .respond(understood.sentenceId, {
              ...answer,
              presentationId: newPresentation(),
              understood: true,
            })
            .pipe(Effect.flip);
          assert.strictEqual(again._tag, "AlreadyAnswered");
          const unknown = yield* practice
            .respond(unknownSentence, {
              ...answer,
              presentationId: newPresentation(),
              understood: true,
            })
            .pipe(Effect.flip);
          assert.strictEqual(unknown._tag, "SentenceNotFound");

          const next = yield* practice.upcoming;
          assert.isFalse(
            next.some(
              (item) =>
                item.sentenceId === missed.sentenceId ||
                item.sentenceId === understood.sentenceId,
            ),
          );

          yield* worker.settle;
          const briefs = yield* Ref.get(fakes.briefs);
          const last = briefs.at(-1);
          assert.deepStrictEqual(
            last?.struggles.map((struggle) => struggle.sentenceId),
            [missed.sentenceId],
          );
          assert.include(last?.recent ?? [], "Hei!");

          const view = yield* practice.view;
          assert.strictEqual(view._tag, "Ready");
          if (view._tag === "Ready") {
            assert.strictEqual(view.stats.answered, 2);
            assert.strictEqual(view.stats.understood, 1);
          }
        }),
      ),
    );

    it.effect("logs presentation events once and links the response", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const sql = yield* PgClient.PgClient;

          yield* freshSession();
          yield* worker.settle;
          const [first, second] = yield* practice.upcoming;
          assert.isDefined(first);
          assert.isDefined(second);
          const presentationId = newPresentation();
          const playbackId = nextUuid();
          const opening = [
            event(0, { _tag: "Presented", autoplay: true, visible: true }),
            event(1, {
              _tag: "PlayRequested",
              playbackId,
              priorStarts: 0,
              trigger: "auto",
            }),
          ];
          const record = (
            sentenceId: SentenceId,
            events: ReadonlyArray<PresentationEvent>,
            id: PresentationId = presentationId,
          ) => practice.recordPresentationEvents(sentenceId, id, events);

          yield* record(first.sentenceId, opening);
          // A retry of the same batch, overlapping new events, stores each once.
          yield* record(first.sentenceId, [
            ...opening,
            event(2, {
              _tag: "PlaybackStarted",
              audioDurationMs: 1800,
              playbackId,
            }),
          ]);

          const clash = yield* record(first.sentenceId, [
            event(2, { _tag: "TranslationRevealed" }),
          ]).pipe(Effect.flip);
          assert.strictEqual(clash._tag, "PresentationConflict");
          const otherSentence = yield* record(second.sentenceId, [
            event(0, { _tag: "Presented", autoplay: false, visible: true }),
          ]).pipe(Effect.flip);
          assert.strictEqual(otherSentence._tag, "PresentationConflict");
          const missing = yield* record(
            unknownSentence,
            [event(0, { _tag: "Presented", autoplay: false, visible: true })],
            newPresentation(),
          ).pipe(Effect.flip);
          assert.strictEqual(missing._tag, "SentenceNotFound");

          const wrongPresentation = yield* practice
            .respond(second.sentenceId, {
              presentationId,
              replayCount: 0,
              translationRevealed: false,
              understood: true,
            })
            .pipe(Effect.flip);
          assert.strictEqual(wrongPresentation._tag, "PresentationConflict");
          yield* practice.respond(first.sentenceId, {
            presentationId,
            replayCount: 0,
            translationRevealed: false,
            understood: true,
          });
          // Events may still arrive after the response.
          yield* record(first.sentenceId, [
            event(3, { _tag: "Responded", understood: true }),
          ]);
          // A response can also arrive before any of its presentation's events.
          const early = newPresentation();
          yield* practice.respond(second.sentenceId, {
            presentationId: early,
            replayCount: 1,
            translationRevealed: true,
            understood: false,
          });
          yield* record(
            second.sentenceId,
            [event(0, { _tag: "Presented", autoplay: true, visible: true })],
            early,
          );

          const Events = Schema.Array(
            Schema.Struct({
              clientElapsedMs: Schema.Finite,
              eventType: Schema.String,
              schemaVersion: Schema.Int,
              sequence: Schema.Int,
            }),
          );
          const events = yield* sql`
            SELECT
              sequence,
              event_type,
              schema_version,
              client_elapsed_ms
            FROM
              practice_presentation_events
            WHERE
              presentation_id = ${presentationId}
            ORDER BY
              sequence
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Events)));
          assert.deepStrictEqual(
            events.map((row) => [row.sequence, row.eventType]),
            [
              [0, "Presented"],
              [1, "PlayRequested"],
              [2, "PlaybackStarted"],
              [3, "Responded"],
            ],
          );
          assert.isTrue(events.every((row) => row.schemaVersion === 1));

          const Links = Schema.Array(
            Schema.Struct({
              presentationId: Schema.NullOr(Schema.String),
              sentenceId: Schema.String,
            }),
          );
          const links = yield* sql`
            SELECT
              sentence_id,
              presentation_id
            FROM
              practice_responses
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Links)));
          assert.sameDeepMembers(
            links.map((row) => [row.sentenceId, row.presentationId]),
            [
              [first.sentenceId, presentationId],
              [second.sentenceId, early],
            ],
          );

          // Starting over removes the log with everything else.
          yield* practice.reset;
          const Count = Schema.Array(Schema.Struct({ count: Schema.Int }));
          const remaining = yield* sql`
            SELECT
              (
                SELECT
                  count(*)::int
                FROM
                  practice_presentation_events
              ) + (
                SELECT
                  count(*)::int
                FROM
                  practice_presentations
              ) AS count
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Count)));
          assert.strictEqual(remaining[0]?.count, 0);
        }),
      ),
    );

    it.effect("fails without retry when too little Finnish was heard", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;

          yield* freshSession();
          yield* Ref.set(fakes.utterances, 1);
          yield* worker.settle;

          const view = yield* practice.view;
          assert.strictEqual(view._tag, "Failed");
          if (view._tag === "Failed") {
            assert.strictEqual(view.failure.reason, "insufficient_material");
            assert.isFalse(view.failure.retryable);
          }
          const retry = yield* practice.retry.pipe(Effect.flip);
          assert.strictEqual(retry._tag, "NotRetryable");
        }),
      ),
    );

    it.effect("retries a failed transcription from the kept recording", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;

          yield* freshSession();
          yield* Ref.set(fakes.failTranscription, true);
          yield* worker.settle;
          const failed = yield* practice.view;
          assert.strictEqual(failed._tag, "Failed");

          yield* Ref.set(fakes.failTranscription, false);
          const retried = yield* practice.retry;
          assert.strictEqual(retried._tag, "Preparing");
          yield* worker.settle;
          assert.strictEqual((yield* practice.view)._tag, "Ready");
        }),
      ),
    );

    it.effect("holds one session at a time and rejects long recordings", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const fakes = yield* Fakes;
          const fs = yield* FileSystem.FileSystem;

          yield* freshSession();
          const path = yield* fs.makeTempFileScoped();
          const second = yield* practice
            .start({ name: "again.m4a", path }, "beginner", "crosstalk")
            .pipe(Effect.flip);
          assert.strictEqual(second._tag, "SessionAlreadyExists");

          yield* practice.reset;
          assert.strictEqual((yield* practice.view)._tag, "NoSession");
          const none = yield* practice.upcoming.pipe(Effect.flip);
          assert.strictEqual(none._tag, "NoActiveSession");

          yield* Ref.set(fakes.recordingSeconds, 45 * 60);
          const long = yield* practice
            .start({ name: "long.m4a", path }, "beginner", "crosstalk")
            .pipe(Effect.flip);
          assert.strictEqual(long._tag, "RecordingRejected");
        }),
      ),
    );

    it.effect("serves each practice mode from its own buffer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;

          const started = yield* freshSession("beginner");
          assert.strictEqual(started._tag, "Preparing");
          if (started._tag !== "NoSession") {
            assert.strictEqual(started.mode, "beginner");
          }
          yield* worker.settle;
          const briefs = yield* Ref.get(fakes.briefs);
          assert.isTrue(briefs.every((brief) => brief.mode === "beginner"));
          const stored = yield* generationRows;
          assert.isTrue(
            stored.every(
              (row) =>
                row.generationMode === "beginner" &&
                row.generationPolicy === "beginner-single-clause-v1",
            ),
          );
          const [current] = yield* practice.upcoming;
          assert.isDefined(current);
          assert.strictEqual(current.mode, "beginner");

          // Switching keeps the beginner sentence being heard answerable.
          const presentationId = newPresentation();
          yield* practice.recordPresentationEvents(
            current.sentenceId,
            presentationId,
            [event(0, { _tag: "Presented", autoplay: true, visible: true })],
          );
          const switched = yield* practice.setMode("intermediate");
          assert.strictEqual(switched._tag, "Ready");
          if (switched._tag === "Ready") {
            assert.strictEqual(switched.mode, "intermediate");
            // Voiced beginner sentences still count as buffered.
            assert.isAbove(switched.stats.buffered, 0);
          }
          // Nothing intermediate is ready yet; beginner sentences are not served.
          assert.deepStrictEqual(yield* practice.upcoming, []);
          yield* practice.respond(current.sentenceId, {
            presentationId,
            replayCount: 0,
            translationRevealed: false,
            understood: false,
          });
          yield* practice.recordPresentationEvents(
            current.sentenceId,
            presentationId,
            [event(1, { _tag: "Responded", understood: false })],
          );

          yield* worker.settle;
          const intermediateBriefs = (yield* Ref.get(fakes.briefs)).slice(
            briefs.length,
          );
          assert.isAbove(intermediateBriefs.length, 0);
          assert.isTrue(
            intermediateBriefs.every((brief) => brief.mode === "intermediate"),
          );
          // Struggles and recent sentences carry over from the other mode.
          assert.deepStrictEqual(
            intermediateBriefs[0]?.struggles.map((s) => s.sentenceId),
            [current.sentenceId],
          );
          assert.include(intermediateBriefs[0]?.recent ?? [], "Hei!");
          const intermediate = yield* practice.upcoming;
          assert.isAbove(intermediate.length, 0);
          assert.isTrue(
            intermediate.every((item) => item.mode === "intermediate"),
          );
          const rows = yield* generationRows;
          const count = (mode: string) =>
            rows.filter((row) => row.generationMode === mode && !row.answered)
              .length;
          assert.isAtLeast(count("intermediate"), settings.bufferSize);
          assert.isAtLeast(
            rows.filter((row) => row.generationPolicy === "intermediate-v1")
              .length,
            settings.bufferSize,
          );

          // Switching back reuses the beginner sentences still waiting.
          const again = yield* practice.setMode("beginner");
          assert.strictEqual(again._tag === "Ready" && again.mode, "beginner");
          const beginner = yield* practice.upcoming;
          assert.isAbove(beginner.length, 0);
          assert.isTrue(beginner.every((item) => item.mode === "beginner"));
          assert.isFalse(
            beginner.some((item) => item.sentenceId === current.sentenceId),
          );
          // Choosing the current mode again changes nothing.
          const same = yield* practice.setMode("beginner");
          assert.strictEqual(same._tag === "Ready" && same.mode, "beginner");
          assert.strictEqual((yield* generationRows).length, rows.length);
        }),
      ),
    );

    it.effect("keeps a batch's mode when the learner switches mid-batch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;

          yield* freshSession("beginner");
          yield* Ref.set(
            fakes.duringWrite,
            practice.setMode("intermediate").pipe(Effect.orDie, Effect.asVoid),
          );
          yield* worker.settle;

          const modes = (yield* Ref.get(fakes.briefs)).map(
            (brief) => brief.mode,
          );
          assert.strictEqual(modes[0], "beginner");
          assert.isTrue(
            modes.slice(1).every((mode) => mode === "intermediate"),
          );
          const rows = yield* generationRows;
          const beginner = rows.filter(
            (row) => row.generationMode === "beginner",
          );
          // The batch under way is stored as beginner, but no longer voiced.
          assert.strictEqual(beginner.length, settings.batchSize);
          assert.isTrue(beginner.every((row) => !row.voiced));
          assert.isAtLeast(
            rows.filter(
              (row) => row.generationMode === "intermediate" && row.voiced,
            ).length,
            settings.bufferSize,
          );
          const upcoming = yield* practice.upcoming;
          assert.isTrue(upcoming.every((item) => item.mode === "intermediate"));
        }),
      ),
    );

    it.effect("requires a session to change mode", () =>
      Effect.gen(function* () {
        const practice = yield* Practice;
        yield* practice.reset;
        const error = yield* practice.setMode("beginner").pipe(Effect.flip);
        assert.strictEqual(error._tag, "NoActiveSession");
      }),
    );

    // Rebuilds the schema, so it runs last.
    it.effect("labels sentences from before modes as legacy intermediate", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`DROP SCHEMA public CASCADE`;
        yield* sql`CREATE SCHEMA public`;
        const {
          "0003_practice_modes": _modes,
          "0004_curriculum": _curriculum,
          "0005_curriculum_rejections": _rejections,
          ...before
        } = migrationSteps;
        yield* PgMigrator.run({ loader: PgMigrator.fromRecord(before) });
        yield* sql`
          INSERT INTO
            practice_sessions (file_name, stage, recording_mime_type, recording_seconds)
          VALUES
            ('old.m4a', 'transcribing', 'audio/mp3', 60)
        `;
        yield* sql`
          INSERT INTO
            practice_sentences (session_id, finnish, english, normalized)
          SELECT
            session_id,
            'Hei!',
            'Hello!',
            'hei'
          FROM
            practice_sessions
        `;
        yield* PgMigrator.run({
          loader: PgMigrator.fromRecord(migrationSteps),
        });

        const Modes = Schema.Array(Schema.Struct({ mode: Schema.String }));
        const sessions = yield* sql`
          SELECT
            mode
          FROM
            practice_sessions
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Modes)));
        assert.deepStrictEqual(sessions, [{ mode: "intermediate" }]);
        const rows = yield* generationRows;
        assert.deepStrictEqual(
          rows.map((row) => [row.generationMode, row.generationPolicy]),
          [["intermediate", "legacy-v0"]],
        );
        const Tracks = Schema.Array(Schema.Struct({ track: Schema.String }));
        const tracks = yield* sql`
          SELECT
            track
          FROM
            practice_sessions
          UNION ALL
          SELECT
            track
          FROM
            practice_sentences
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tracks)));
        assert.deepStrictEqual(tracks, [
          { track: "crosstalk" },
          { track: "crosstalk" },
        ]);
        // New rows must state their mode and policy explicitly.
        const missing = yield* sql`
          INSERT INTO
            practice_sentences (session_id, finnish, english, normalized)
          SELECT
            session_id,
            'Moi!',
            'Hi!',
            'moi'
          FROM
            practice_sessions
        `.pipe(Effect.flip);
        assert.strictEqual(missing._tag, "SqlError");
        yield* sql`DELETE FROM practice_sessions`;
      }),
    );
  });
});

const EvidenceRows = Schema.Array(
  Schema.Struct({
    revision: Schema.Int,
    sentenceId: Schema.NullOr(Schema.String),
    startedPlaybacks: Schema.NullOr(Schema.Int),
    targetId: Schema.String,
    traceComplete: Schema.Boolean,
    translationRevealed: Schema.Boolean,
    understood: Schema.Boolean,
  }),
);

const evidenceRows = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  return yield* sql`
    SELECT
      sentence_id::text,
      target_id,
      understood,
      translation_revealed,
      started_playbacks,
      trace_complete,
      revision
    FROM
      curriculum_evidence
    ORDER BY
      evidence_id
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(EvidenceRows)));
});

/** Hears a sentence once, logs it completely and responds. */
const listen = Effect.fnUntraced(function* (
  sentenceId: SentenceId,
  understood: boolean,
) {
  const practice = yield* Practice;
  const presentationId = newPresentation();
  const playbackId = nextUuid();
  yield* practice.recordPresentationEvents(sentenceId, presentationId, [
    event(0, { _tag: "Presented", autoplay: true, visible: true }),
    event(1, {
      _tag: "PlayRequested",
      playbackId,
      priorStarts: 0,
      trigger: "auto",
    }),
    event(2, { _tag: "PlaybackStarted", audioDurationMs: 1500, playbackId }),
    event(3, { _tag: "Responded", understood }),
  ]);
  yield* practice.curriculumRespond(sentenceId, {
    presentationId,
    replayCount: 0,
    translationRevealed: false,
    understood,
  });
});

describe.skipIf(url === undefined)("Curriculum practice (PostgreSQL)", () => {
  it.layer(TestLayer, { timeout: 30000 })((it) => {
    it.effect("prepares a small buffer of curriculum sentences", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;

          const started = yield* freshSession("beginner", "curriculum");
          assert.strictEqual(started._tag, "Preparing");
          if (started._tag === "Preparing") {
            assert.strictEqual(started.track, "curriculum");
          }
          yield* worker.settle;

          const view = yield* practice.view;
          assert.strictEqual(view._tag, "Ready");
          const rows = yield* generationRows.pipe(
            Effect.orElseSucceed(() => []),
          );
          assert.deepStrictEqual(rows, []);
          const briefs = yield* Ref.get(fakes.curriculumBriefs);
          assert.strictEqual(briefs.length, settings.curriculumBufferSize);
          const roots = new Set([
            "participants-i-you",
            "negation-present",
            "question-yes-no",
            "question-words",
          ]);
          for (const brief of briefs) {
            assert.isTrue(roots.has(brief.target.id));
            assert.strictEqual(brief.register, "Spoken Finnish");
            assert.deepStrictEqual(brief.supporting, []);
            assert.deepStrictEqual(
              brief.background.map((grammar) => grammar.id),
              ["background-copula-statements"],
            );
            assert.deepStrictEqual(
              brief.vocabulary.map((item) => item.lemma),
              ["kahvi"],
            );
          }

          const upcoming = yield* practice.curriculumUpcoming;
          assert.strictEqual(upcoming.length, 4);
          for (const item of upcoming) {
            assert.strictEqual(item.track, "curriculum");
            assert.isNull(item.mode);
          }
          // Curriculum sentences never appear in crosstalk practice.
          assert.deepStrictEqual(yield* practice.upcoming, []);
        }),
      ),
    );

    it.effect("writes several curriculum sentences at once", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;
          const sql = yield* PgClient.PgClient;

          yield* freshSession("beginner", "curriculum");
          // Would never finish if writes ran one after another.
          yield* Ref.set(fakes.concurrentWrites, {
            count: settings.curriculumConcurrency,
            open: yield* Deferred.make<void>(),
            started: yield* Ref.make(0),
          });
          yield* worker.settle;
          const plans = yield* sql`
            SELECT
              rejections
            FROM
              curriculum_plans
            WHERE
              status = 'written'
            ORDER BY
              seq
          `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    rejections: Schema.Array(
                      Schema.Struct({
                        finnish: Schema.String,
                        reason: Schema.String,
                      }),
                    ),
                  }),
                ),
              ),
            ),
          );
          // Never more than the buffer, and every sentence voiced.
          assert.strictEqual(plans.length, settings.curriculumBufferSize);
          assert.deepStrictEqual(plans[0]?.rejections, [
            { finnish: "Huono lause.", reason: "stilted" },
          ]);
          const awaiting = yield* sql`
            SELECT
              count(*)::int AS count
            FROM
              practice_sentences
            WHERE
              track = 'curriculum'
              AND audio IS NULL
          `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ count: Schema.Int })),
              ),
            ),
          );
          assert.strictEqual(awaiting[0]?.count, 0);
        }),
      ),
    );

    it.effect("starts writing on each answer while earlier writing runs", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;

          yield* freshSession("beginner", "curriculum");
          yield* worker.settle;
          const before = (yield* Ref.get(fakes.curriculumBriefs)).length;
          // Each write waits until two are under way: the first answer's
          // job must still be writing when the second answer starts another.
          yield* Ref.set(fakes.concurrentWrites, {
            count: 2,
            open: yield* Deferred.make<void>(),
            started: yield* Ref.make(0),
          });
          const [first, second] = yield* practice.curriculumUpcoming;
          assert.isDefined(first);
          assert.isDefined(second);
          yield* listen(first.sentenceId, true);
          yield* worker.runPass;
          yield* listen(second.sentenceId, true);
          yield* worker.runPass;
          yield* worker.settle;

          const writes = (yield* Ref.get(fakes.curriculumBriefs)).length;
          assert.strictEqual(writes - before, 2);
          const sql = yield* PgClient.PgClient;
          const unanswered = yield* sql`
            SELECT
              count(*)::int AS count
            FROM
              practice_sentences s
              LEFT JOIN practice_responses r ON r.sentence_id = s.sentence_id
            WHERE
              s.track = 'curriculum'
              AND s.audio IS NOT NULL
              AND r.sentence_id IS NULL
          `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ count: Schema.Int })),
              ),
            ),
          );
          assert.strictEqual(
            unanswered[0]?.count,
            settings.curriculumBufferSize,
          );
        }),
      ),
    );

    it.effect("reads evidence in response order past ten responses", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* CurriculumStore;
          const sql = yield* PgClient.PgClient;

          yield* freshSession("beginner", "curriculum");
          yield* sql`
            INSERT INTO
              curriculum_evidence (
                plan_seq,
                catalog_version,
                target_id,
                target_revision,
                role,
                family,
                content_key,
                finnish,
                english,
                understood,
                translation_revealed,
                trace_complete,
                responded_at
              )
            SELECT
              n,
              'v',
              'location-inside',
              1,
              'teaching',
              'f',
              'c',
              'Lause.',
              'Sentence.',
              TRUE,
              FALSE,
              TRUE,
              now()
            FROM
              generate_series(1, 12) AS n
          `;
          const observations = yield* store.observations;
          assert.deepStrictEqual(
            observations.map((observation) => observation.position),
            Array.from({ length: 12 }, (_, index) => index + 1),
          );
        }),
      ),
    );

    it.effect("keeps a second teaching sentence from one writing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;
          const sql = yield* PgClient.PgClient;

          yield* freshSession("beginner", "curriculum");
          yield* Ref.set(fakes.curriculumDrafts, 3);
          yield* worker.settle;
          const plans = yield* sql`
            SELECT
              reason
            FROM
              curriculum_plans
            WHERE
              status = 'written'
          `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ reason: Schema.String })),
              ),
            ),
          );
          // The buffer fills from fewer writings, and never overfills.
          assert.strictEqual(plans.length, settings.curriculumBufferSize);
          const writings = (yield* Ref.get(fakes.curriculumBriefs)).length;
          assert.isBelow(writings, plans.length);
          assert.isTrue(
            plans.some((plan) => plan.reason.includes("same writing")),
          );
        }),
      ),
    );

    it.effect(
      "records each response once and refines it from late events",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const practice = yield* Practice;
            const worker = yield* PracticeWorker;

            yield* freshSession("beginner", "curriculum");
            yield* worker.settle;
            const [first, second] = yield* practice.curriculumUpcoming;
            assert.isDefined(first);
            assert.isDefined(second);

            const presentationId = newPresentation();
            const response = {
              presentationId,
              replayCount: 0,
              translationRevealed: false,
              understood: true,
            };
            yield* practice.curriculumRespond(first.sentenceId, response);
            // An identical resend (e.g. after a lost reply) is fine...
            yield* practice.curriculumRespond(first.sentenceId, response);
            // ...a different answer is not, on either route.
            const changed = yield* practice
              .curriculumRespond(first.sentenceId, {
                ...response,
                understood: false,
              })
              .pipe(Effect.flip);
            assert.strictEqual(changed._tag, "AlreadyAnswered");
            const crosstalk = yield* practice
              .respond(first.sentenceId, response)
              .pipe(Effect.flip);
            assert.strictEqual(crosstalk._tag, "AlreadyAnswered");

            let [evidence] = yield* evidenceRows;
            assert.strictEqual(evidence?.traceComplete, false);
            assert.strictEqual(evidence?.startedPlaybacks, 0);

            const playbackId = nextUuid();
            yield* practice.recordPresentationEvents(
              first.sentenceId,
              presentationId,
              [
                event(0, { _tag: "Presented", autoplay: true, visible: true }),
                event(2, { _tag: "Responded", understood: true }),
              ],
            );
            [evidence] = yield* evidenceRows;
            assert.strictEqual(evidence?.traceComplete, false);
            yield* practice.recordPresentationEvents(
              first.sentenceId,
              presentationId,
              [
                event(1, {
                  _tag: "PlaybackStarted",
                  audioDurationMs: 900,
                  playbackId,
                }),
              ],
            );
            [evidence] = yield* evidenceRows;
            assert.strictEqual(evidence?.traceComplete, true);
            assert.strictEqual(evidence?.startedPlaybacks, 1);
            assert.isFalse(evidence?.translationRevealed);

            // A reveal in an earlier presentation (before a reload) still counts.
            yield* practice.recordPresentationEvents(
              first.sentenceId,
              newPresentation(),
              [
                event(0, { _tag: "Presented", autoplay: true, visible: true }),
                event(1, { _tag: "TranslationRevealed" }),
              ],
            );
            [evidence] = yield* evidenceRows;
            assert.isTrue(evidence?.translationRevealed);
            const revision = (yield* evidenceRows)[0]?.revision;
            // Resent events change nothing.
            yield* practice.curriculumRespond(first.sentenceId, response);
            [evidence] = yield* evidenceRows;
            assert.strictEqual(evidence?.revision, revision);

            // Events before the response complete the evidence immediately.
            yield* listen(second.sentenceId, false);
            const rows = yield* evidenceRows;
            assert.strictEqual(rows.length, 2);
            const latest = rows[1];
            assert.isDefined(latest);
            assert.isTrue(latest.traceComplete);
            assert.isFalse(latest.understood);

            const unknown = yield* practice
              .curriculumRespond(unknownSentence, response)
              .pipe(Effect.flip);
            assert.strictEqual(unknown._tag, "SentenceNotFound");
          }),
        ),
    );

    it.effect("simplifies what it teaches after repeated failures", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;

          yield* freshSession("beginner", "curriculum");
          yield* worker.settle;
          // Enough failures for each of the four initial targets.
          for (let round = 0; round < 12; round += 1) {
            const [next] = yield* practice.curriculumUpcoming;
            assert.isDefined(next);
            yield* listen(next.sentenceId, false);
            yield* worker.settle;
          }
          const briefs = yield* Ref.get(fakes.curriculumBriefs);
          assert.isTrue(briefs.slice(-3).every((brief) => brief.plan.easier));
          assert.isFalse(briefs.slice(0, 3).some((brief) => brief.plan.easier));
        }),
      ),
    );

    it.effect("keeps progress across a new recording until starting over", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const fs = yield* FileSystem.FileSystem;

          yield* freshSession("beginner", "curriculum");
          yield* worker.settle;
          const [next] = yield* practice.curriculumUpcoming;
          assert.isDefined(next);
          yield* listen(next.sentenceId, true);

          yield* practice.replaceRecording;
          assert.strictEqual((yield* practice.view)._tag, "NoSession");
          const kept = yield* evidenceRows;
          assert.strictEqual(kept.length, 1);
          assert.isNull(kept[0]?.sentenceId ?? null);
          assert.isTrue(kept[0]?.understood);
          // Replacing is idempotent.
          yield* practice.replaceRecording;

          const path = yield* fs.makeTempFileScoped();
          yield* Ref.set(fakes.curriculumBriefs, []);
          yield* practice.start(
            { name: "next.m4a", path },
            "beginner",
            "curriculum",
          );
          yield* worker.settle;
          assert.isNotEmpty(yield* Ref.get(fakes.curriculumBriefs));
          assert.strictEqual((yield* evidenceRows).length, 1);

          yield* practice.reset;
          assert.deepStrictEqual(yield* evidenceRows, []);
        }),
      ),
    );

    it.effect(
      "switches tracks after the current sentence, keeping both buffers",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const practice = yield* Practice;
            const worker = yield* PracticeWorker;
            const fakes = yield* Fakes;

            yield* freshSession("beginner", "crosstalk");
            yield* worker.settle;
            assert.deepStrictEqual(yield* Ref.get(fakes.curriculumBriefs), []);
            const crosstalk = yield* practice.upcoming;
            assert.isNotEmpty(crosstalk);

            const switched = yield* practice.setTrack("curriculum");
            assert.strictEqual(switched._tag, "Ready");
            if (switched._tag === "Ready") {
              assert.strictEqual(switched.track, "curriculum");
            }
            yield* worker.settle;
            assert.isNotEmpty(yield* practice.curriculumUpcoming);
            // The crosstalk buffer waits for switching back.
            assert.deepStrictEqual(
              (yield* practice.upcoming).map((item) => item.sentenceId),
              crosstalk.map((item) => item.sentenceId),
            );
            yield* practice.setTrack("curriculum");

            yield* practice.reset;
            const none = yield* practice
              .setTrack("crosstalk")
              .pipe(Effect.flip);
            assert.strictEqual(none._tag, "NoActiveSession");
          }),
        ),
    );

    it.effect("stops starting jobs when generation keeps failing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;
          const settings = yield* PracticeSettings;

          yield* freshSession("beginner", "curriculum");
          yield* Ref.set(fakes.failCurriculum, true);
          yield* worker.settle;
          // Three failures in a row, plus the other jobs already under way.
          const attempts = (yield* Ref.get(fakes.curriculumBriefs)).length;
          assert.isAtLeast(attempts, 3);
          assert.isAtMost(attempts, 3 + settings.curriculumConcurrency - 1);
          const sql = yield* PgClient.PgClient;
          const failed = yield* sql`
            SELECT
              rejections
            FROM
              curriculum_plans
            WHERE
              status = 'failed'
          `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    rejections: Schema.Array(
                      Schema.Struct({
                        finnish: Schema.String,
                        reason: Schema.String,
                      }),
                    ),
                  }),
                ),
              ),
            ),
          );
          assert.strictEqual(failed.length, attempts);
          assert.include(failed[0]?.rejections[0]?.reason, "generation failed");
          const view = yield* practice.view;
          assert.strictEqual(view._tag, "Preparing");

          yield* Ref.set(fakes.failCurriculum, false);
          yield* worker.settle;
          assert.strictEqual((yield* practice.view)._tag, "Ready");
        }),
      ),
    );
  });
});

describe.skipIf(url === undefined)(
  "Practice mode over HTTP (PostgreSQL)",
  () => {
    const Mode = Schema.Struct({ mode: Schema.String });
    const decodeMode = Schema.decodeUnknownSync(Mode);
    const decodeTrack = Schema.decodeUnknownSync(
      Schema.Struct({ _tag: Schema.String, track: Schema.String }),
    );
    const decodeTag = Schema.decodeUnknownSync(
      Schema.Struct({ _tag: Schema.String }),
    );
    const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
    /** The web handler speaks promises; this is the one place they enter. */
    const fromPromise = <Args extends ReadonlyArray<unknown>, A>(
      run: (...args: Args) => Promise<A>,
      ...args: Args
    ) =>
      // eslint-disable-next-line effecttsgo/async-function -- Bridges the promise-based web handler.
      Effect.promise(async () => run(...args));

    it.effect(
      "defaults unspecified uploads to intermediate and changes mode",
      () =>
        Effect.gen(function* () {
          const { dispose, handler } = HttpRouter.toWebHandler(
            apiRoutes.pipe(
              // The audio route asks for Practice per request.
              HttpRouter.provideRequest(TestLayer),
              Layer.provide(TestLayer),
              Layer.provide(NodeHttpServer.layerHttpServices),
            ),
            { disableLogger: true },
          );
          yield* Effect.addFinalizer(() => fromPromise(dispose));
          const send = (path: string, init: RequestInit) =>
            fromPromise(handler, new Request(`http://test${path}`, init));
          const json = (response: Response) =>
            fromPromise(response.json.bind(response) as () => Promise<unknown>);
          const upload = (mode?: string) => {
            const form = new FormData();
            if (mode !== undefined) {
              form.append("mode", mode);
            }
            form.append("recording", new File(["not audio"], "session.m4a"));
            return send("/api/session", { body: form, method: "POST" });
          };
          const setMode = (mode: string) =>
            send("/api/session/mode", {
              body: Schema.encodeSync(Schema.fromJsonString(Mode))({ mode }),
              headers: { "content-type": "application/json" },
              method: "PUT",
            });
          const reset = send("/api/session", { method: "DELETE" });

          yield* reset;
          const legacy = yield* upload();
          assert.strictEqual(legacy.status, 200);
          assert.strictEqual(
            decodeMode(yield* json(legacy)).mode,
            "intermediate",
          );

          yield* reset;
          const invalid = yield* upload("expert");
          assert.strictEqual(invalid.status, 400);
          const beginner = yield* upload("beginner");
          assert.strictEqual(beginner.status, 200);
          assert.strictEqual(
            decodeMode(yield* json(beginner)).mode,
            "beginner",
          );

          const changed = yield* setMode("intermediate");
          assert.strictEqual(changed.status, 200);
          assert.strictEqual(
            decodeMode(yield* json(changed)).mode,
            "intermediate",
          );
          assert.strictEqual((yield* setMode("expert")).status, 400);

          yield* reset;
          const none = yield* setMode("beginner");
          assert.strictEqual(none.status, 409);
        }).pipe(Effect.scoped),
    );

    it.effect("chooses tracks and replaces recordings over HTTP", () =>
      Effect.gen(function* () {
        const { dispose, handler } = HttpRouter.toWebHandler(
          apiRoutes.pipe(
            HttpRouter.provideRequest(TestLayer),
            Layer.provide(TestLayer),
            Layer.provide(NodeHttpServer.layerHttpServices),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => fromPromise(dispose));
        const send = (path: string, init: RequestInit = {}) =>
          fromPromise(handler, new Request(`http://test${path}`, init));
        const json = (response: Response) =>
          fromPromise(response.json.bind(response) as () => Promise<unknown>);
        const upload = (track?: string) => {
          const form = new FormData();
          if (track !== undefined) {
            form.append("track", track);
          }
          form.append("recording", new File(["not audio"], "session.m4a"));
          return send("/api/session", { body: form, method: "POST" });
        };
        const setTrack = (track: string) =>
          send("/api/session/track", {
            body: toJson({ track }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          });

        yield* send("/api/session", { method: "DELETE" });
        const legacy = yield* upload();
        assert.strictEqual(decodeTrack(yield* json(legacy)).track, "crosstalk");
        const replaced = yield* send("/api/session/recording", {
          method: "DELETE",
        });
        assert.strictEqual(replaced.status, 204);
        const gone = yield* json(yield* send("/api/session"));
        assert.strictEqual(decodeTag(gone)._tag, "NoSession");

        assert.strictEqual((yield* upload("expert")).status, 400);
        const curriculum = yield* upload("curriculum");
        assert.strictEqual(
          decodeTrack(yield* json(curriculum)).track,
          "curriculum",
        );
        // Still preparing: nothing to serve yet.
        assert.strictEqual(
          (yield* send("/api/curriculum/upcoming")).status,
          409,
        );
        const unknown = yield* send(
          `/api/curriculum/sentences/${unknownSentence}/response`,
          {
            body: toJson({
              presentationId: nextUuid(),
              replayCount: 0,
              translationRevealed: false,
              understood: true,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        assert.strictEqual(unknown.status, 404);

        const changed = yield* setTrack("crosstalk");
        assert.strictEqual(
          decodeTrack(yield* json(changed)).track,
          "crosstalk",
        );
        assert.strictEqual((yield* setTrack("grammar")).status, 400);
        yield* send("/api/session", { method: "DELETE" });
        assert.strictEqual((yield* setTrack("curriculum")).status, 409);
      }).pipe(Effect.scoped),
    );
  },
);

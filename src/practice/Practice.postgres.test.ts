import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";

import { RecordingConverter } from "../audio/RecordingConverter.ts";
import { clientLayer, migrations } from "../db/Database.ts";
import { SentenceId } from "../domain/model.ts";
import type { SessionProfile } from "../domain/model.ts";
import { SpeechSynthesizer } from "../speech/SpeechSynthesizer.ts";
import { Transcriber, TranscriptionError } from "../speech/Transcriber.ts";
import { Practice } from "./Practice.ts";
import { PracticeSettings } from "./PracticeSettings.ts";
import { practiceStorePostgres } from "./PracticeStorePostgres.ts";
import { PracticeWorker } from "./PracticeWorker.ts";
import { SentenceAuthor } from "./SentenceAuthor.ts";
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

/** Knobs and observations for the fake providers. */
class Fakes extends Context.Service<
  Fakes,
  {
    readonly utterances: Ref.Ref<number>;
    readonly recordingSeconds: Ref.Ref<number>;
    readonly failTranscription: Ref.Ref<boolean>;
    readonly briefs: Ref.Ref<ReadonlyArray<SentenceBrief>>;
    readonly written: Ref.Ref<number>;
  }
>()("test/Fakes") {}

const fakesLayer = Layer.effect(
  Fakes,
  Effect.gen(function* () {
    return Fakes.of({
      briefs: yield* Ref.make<ReadonlyArray<SentenceBrief>>([]),
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

/** A fresh session from a throwaway upload, with every fake reset. */
const freshSession = Effect.gen(function* () {
  const practice = yield* Practice;
  const fakes = yield* Fakes;
  const fs = yield* FileSystem.FileSystem;
  yield* practice.reset;
  yield* Ref.set(fakes.utterances, 3);
  yield* Ref.set(fakes.recordingSeconds, 120);
  yield* Ref.set(fakes.failTranscription, false);
  yield* Ref.set(fakes.briefs, []);
  const path = yield* fs.makeTempFileScoped();
  yield* fs.writeFileString(path, "not really audio");
  return yield* practice.start({ name: "session.m4a", path });
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

          const started = yield* freshSession;
          assert.strictEqual(started._tag, "Preparing");
          const recordings = yield* fs.readDirectory(
            `${settings.dataDir}/recordings`,
          );
          assert.strictEqual(recordings.length, 1);

          yield* worker.runPass;

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

          yield* freshSession;
          yield* worker.runPass;
          const [missed, understood] = yield* practice.upcoming;
          assert.isDefined(missed);
          assert.isDefined(understood);
          const answer = { replayCount: 2, translationRevealed: true };
          yield* practice.respond(missed.sentenceId, {
            ...answer,
            understood: false,
          });
          yield* practice.respond(understood.sentenceId, {
            ...answer,
            understood: true,
          });

          const again = yield* practice
            .respond(understood.sentenceId, { ...answer, understood: true })
            .pipe(Effect.flip);
          assert.strictEqual(again._tag, "AlreadyAnswered");
          const unknown = yield* practice
            .respond(unknownSentence, {
              ...answer,
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

          yield* worker.runPass;
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

    it.effect("fails without retry when too little Finnish was heard", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const practice = yield* Practice;
          const worker = yield* PracticeWorker;
          const fakes = yield* Fakes;

          yield* freshSession;
          yield* Ref.set(fakes.utterances, 1);
          yield* worker.runPass;

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

          yield* freshSession;
          yield* Ref.set(fakes.failTranscription, true);
          yield* worker.runPass;
          const failed = yield* practice.view;
          assert.strictEqual(failed._tag, "Failed");

          yield* Ref.set(fakes.failTranscription, false);
          const retried = yield* practice.retry;
          assert.strictEqual(retried._tag, "Preparing");
          yield* worker.runPass;
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

          yield* freshSession;
          const path = yield* fs.makeTempFileScoped();
          const second = yield* practice
            .start({ name: "again.m4a", path })
            .pipe(Effect.flip);
          assert.strictEqual(second._tag, "SessionAlreadyExists");

          yield* practice.reset;
          assert.strictEqual((yield* practice.view)._tag, "NoSession");
          const none = yield* practice.upcoming.pipe(Effect.flip);
          assert.strictEqual(none._tag, "NoActiveSession");

          yield* Ref.set(fakes.recordingSeconds, 45 * 60);
          const long = yield* practice
            .start({ name: "long.m4a", path })
            .pipe(Effect.flip);
          assert.strictEqual(long._tag, "RecordingRejected");
        }),
      ),
    );
  });
});

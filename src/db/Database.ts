import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, Effect, Layer, Redacted, String } from "effect";

/**
 * One active practice session at a time (`singleton`), its sentences and
 * the learner's single response to each. Deleting the session cascades to
 * everything generated from it.
 */
export const migrations = PgMigrator.layer({
  loader: PgMigrator.fromRecord({
    "0001_practice": Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        CREATE TABLE practice_sessions (
          session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          singleton boolean NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
          file_name text NOT NULL,
          stage text NOT NULL CHECK (stage IN ('transcribing', 'analyzing', 'ready', 'failed')),
          failed_stage text CHECK (failed_stage IN ('transcribing', 'analyzing')),
          failure jsonb,
          recording_path text,
          recording_mime_type text NOT NULL,
          recording_seconds double precision NOT NULL,
          transcript jsonb,
          profile jsonb,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          CHECK ((stage = 'failed') = (failure IS NOT NULL)),
          CHECK ((stage = 'failed') = (failed_stage IS NOT NULL)),
          CHECK (
            stage NOT IN ('analyzing', 'ready')
            OR transcript IS NOT NULL
          ),
          CHECK (
            stage <> 'ready'
            OR profile IS NOT NULL
          )
        )
      `;
      yield* sql`
        CREATE TABLE practice_sentences (
          sentence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id uuid NOT NULL REFERENCES practice_sessions (session_id) ON DELETE CASCADE,
          position bigint GENERATED ALWAYS AS IDENTITY,
          finnish text NOT NULL,
          english text NOT NULL,
          normalized text NOT NULL,
          variation_of uuid REFERENCES practice_sentences (sentence_id) ON DELETE SET NULL,
          audio bytea,
          audio_mime_type text,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          UNIQUE (session_id, normalized),
          CHECK ((audio IS NULL) = (audio_mime_type IS NULL))
        )
      `;
      yield* sql`
        CREATE INDEX practice_sentences_session_position ON practice_sentences (session_id, position)
      `;
      yield* sql`
        CREATE TABLE practice_responses (
          sentence_id uuid PRIMARY KEY REFERENCES practice_sentences (sentence_id) ON DELETE CASCADE,
          understood boolean NOT NULL,
          translation_revealed boolean NOT NULL,
          replay_count integer NOT NULL CHECK (replay_count >= 0),
          answered_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `;
    }),
  }),
}).pipe(Layer.provide(NodeServices.layer));

/** Result names are camelCased so a misspelt column fails decoding loudly. */
export const clientLayer = (url: Config.Config<Redacted.Redacted>) =>
  PgClient.layerConfig({
    applicationName: Config.succeed("crosstalk-practice"),
    maxConnections: Config.succeed(5),
    transformQueryNames: Config.succeed(String.camelToSnake),
    transformResultNames: Config.succeed(String.snakeToCamel),
    url,
  });

export const databaseLive = migrations.pipe(
  Layer.provideMerge(
    clientLayer(
      Config.Redacted("DATABASE_URL").pipe(
        Config.withDefault(
          Redacted.make("postgres://localhost:5432/crosstalk_practice"),
        ),
      ),
    ),
  ),
);

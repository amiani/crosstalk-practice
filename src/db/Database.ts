import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, Effect, Layer, Redacted, String } from "effect";

/**
 * One active practice session at a time (`singleton`), its sentences and
 * the learner's single response to each. Deleting the session cascades to
 * everything generated from it.
 *
 * Each time a sentence is shown is a presentation with an append-only event
 * log; a response points at the presentation it was given in (older
 * responses predate presentations and have none).
 *
 * The session records the practice mode new sentences are written in; each
 * sentence records the mode and generation-policy version it was written
 * under, which never change afterwards.
 *
 * Curriculum practice adds a track to sessions and sentences (curriculum
 * sentences have no practice mode), a plan per curriculum sentence recording
 * why it was chosen, and curriculum evidence: one row per curriculum
 * response, self-contained so it survives replacing the recording. Only
 * "Start over" deletes evidence.
 */
export const migrationSteps = {
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
  "0002_presentation_events": Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      CREATE TABLE practice_presentations (
        presentation_id uuid PRIMARY KEY,
        sentence_id uuid NOT NULL REFERENCES practice_sentences (sentence_id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (presentation_id, sentence_id)
      )
    `;
    yield* sql`
      CREATE INDEX practice_presentations_sentence ON practice_presentations (sentence_id)
    `;
    yield* sql`
      CREATE TABLE practice_presentation_events (
        event_id uuid PRIMARY KEY,
        presentation_id uuid NOT NULL REFERENCES practice_presentations (presentation_id) ON DELETE CASCADE,
        sequence integer NOT NULL CHECK (sequence >= 0),
        event_type text NOT NULL,
        schema_version integer NOT NULL,
        client_elapsed_ms double precision NOT NULL CHECK (client_elapsed_ms >= 0),
        client_time timestamptz NOT NULL,
        detail jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (presentation_id, sequence)
      )
    `;
    yield* sql`
      ALTER TABLE practice_responses
      ADD COLUMN presentation_id uuid UNIQUE,
      ADD FOREIGN KEY (presentation_id, sentence_id) REFERENCES practice_presentations (presentation_id, sentence_id)
    `;
  }),
  "0003_practice_modes": Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // Everything that exists already was written without the beginner
    // restriction, under the rules that predate policy versions.
    yield* sql`
      ALTER TABLE practice_sessions
      ADD COLUMN mode text NOT NULL DEFAULT 'intermediate' CHECK (mode IN ('beginner', 'intermediate'))
    `;
    yield* sql`
      ALTER TABLE practice_sessions
      ALTER COLUMN mode
      DROP DEFAULT
    `;
    yield* sql`
      ALTER TABLE practice_sentences
      ADD COLUMN generation_mode text NOT NULL DEFAULT 'intermediate' CHECK (generation_mode IN ('beginner', 'intermediate')),
      ADD COLUMN generation_policy text NOT NULL DEFAULT 'legacy-v0'
    `;
    yield* sql`
      ALTER TABLE practice_sentences
      ALTER COLUMN generation_mode
      DROP DEFAULT,
      ALTER COLUMN generation_policy
      DROP DEFAULT
    `;
    yield* sql`
      CREATE INDEX practice_sentences_session_mode_position ON practice_sentences (session_id, generation_mode, position)
    `;
  }),
  "0004_curriculum": Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // Everything that exists already is crosstalk practice.
    yield* sql`
      ALTER TABLE practice_sessions
      ADD COLUMN track text NOT NULL DEFAULT 'crosstalk' CHECK (track IN ('crosstalk', 'curriculum'))
    `;
    yield* sql`
      ALTER TABLE practice_sessions
      ALTER COLUMN track
      DROP DEFAULT
    `;
    yield* sql`
      ALTER TABLE practice_sentences
      ADD COLUMN track text NOT NULL DEFAULT 'crosstalk' CHECK (track IN ('crosstalk', 'curriculum')),
      ADD COLUMN speech_source text
    `;
    yield* sql`
      ALTER TABLE practice_sentences
      ALTER COLUMN track
      DROP DEFAULT,
      ALTER COLUMN generation_mode
      DROP NOT NULL,
      ADD CHECK ((track = 'crosstalk') = (generation_mode IS NOT NULL))
    `;
    yield* sql`
      CREATE INDEX practice_sentences_session_track_position ON practice_sentences (session_id, track, position)
    `;
    yield* sql`
      CREATE TABLE curriculum_plans (
        plan_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        session_id uuid NOT NULL REFERENCES practice_sessions (session_id) ON DELETE CASCADE,
        sentence_id uuid UNIQUE REFERENCES practice_sentences (sentence_id) ON DELETE CASCADE,
        status text NOT NULL CHECK (status IN ('pending', 'written', 'failed')),
        catalog_version text NOT NULL,
        target_id text NOT NULL,
        target_revision integer NOT NULL,
        role text NOT NULL CHECK (role IN ('teaching', 'transfer', 'review')),
        easier boolean NOT NULL,
        family text NOT NULL,
        reason text NOT NULL,
        decision jsonb NOT NULL,
        model_version text NOT NULL,
        selection_version text NOT NULL,
        author_version text NOT NULL,
        content_key text,
        realisation text,
        review_note text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((status = 'written') = (sentence_id IS NOT NULL))
      )
    `;
    yield* sql`
      CREATE TABLE curriculum_evidence (
        evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        sentence_id uuid UNIQUE REFERENCES practice_sentences (sentence_id) ON DELETE SET NULL,
        plan_seq bigint NOT NULL,
        catalog_version text NOT NULL,
        target_id text NOT NULL,
        target_revision integer NOT NULL,
        role text NOT NULL CHECK (role IN ('teaching', 'transfer', 'review')),
        family text NOT NULL,
        content_key text NOT NULL,
        finnish text NOT NULL,
        english text NOT NULL,
        understood boolean NOT NULL,
        translation_revealed boolean NOT NULL,
        started_playbacks integer CHECK (started_playbacks >= 0),
        trace_complete boolean NOT NULL,
        usable boolean,
        responded_at timestamptz NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;
  }),
  "0005_curriculum_rejections": Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // Why drafts for a plan were rejected, for auditing the author.
    yield* sql`
      ALTER TABLE curriculum_plans
      ADD COLUMN rejections jsonb
    `;
  }),
};

export const migrations = PgMigrator.layer({
  loader: PgMigrator.fromRecord(migrationSteps),
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

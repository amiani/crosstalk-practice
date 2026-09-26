import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Option, Schema } from "effect";

import {
  AlreadyAnswered,
  SentenceId,
  SentenceNotFound,
  SessionAlreadyExists,
  SessionFailure,
  SessionId,
  SessionProfile,
  Transcript,
} from "../domain/model.ts";
import type {
  PracticeResponse,
  SessionFailure as SessionFailureType,
  SessionProfile as SessionProfileType,
  Transcript as TranscriptType,
} from "../domain/model.ts";
import type { SynthesizedSpeech } from "../speech/SpeechSynthesizer.ts";
import { PracticeStore, PracticeStoreError } from "./PracticeStore.ts";
import type { NewSession, PreparationStep } from "./PracticeStore.ts";
import type { SentenceDraft } from "./SentenceAuthor.ts";

const SessionRow = Schema.Struct({
  createdAt: Schema.String,
  failedStage: Schema.NullOr(Schema.Literals(["transcribing", "analyzing"])),
  failure: Schema.NullOr(SessionFailure),
  fileName: Schema.String,
  profile: Schema.NullOr(SessionProfile),
  recordingMimeType: Schema.String,
  recordingPath: Schema.NullOr(Schema.String),
  recordingSeconds: Schema.Finite,
  sessionId: SessionId,
  stage: Schema.Literals(["transcribing", "analyzing", "ready", "failed"]),
  transcript: Schema.NullOr(Transcript),
});
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow));

const decodeCounts = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      answered: Schema.Int,
      buffered: Schema.Int,
      unanswered: Schema.Int,
      understood: Schema.Int,
    }),
  ),
);
const decodeFinnish = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ finnish: Schema.String })),
);
const decodeStruggles = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      english: Schema.String,
      finnish: Schema.String,
      sentenceId: SentenceId,
    }),
  ),
);
const decodeAwaiting = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ finnish: Schema.String, sentenceId: SentenceId }),
  ),
);
const decodeUpcoming = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ english: Schema.String, sentenceId: SentenceId }),
  ),
);
const decodeAudio = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ audio: Schema.Uint8Array, audioMimeType: Schema.String }),
  ),
);
const decodeAnswered = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ answered: Schema.Boolean })),
);

const storeError = (cause: unknown) => new PracticeStoreError({ cause });

export const practiceStorePostgres = Layer.effect(
  PracticeStore,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const iso = (column: string) =>
      sql.literal(
        `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      );
    const selectSession = sql`
      SELECT
        session_id,
        file_name,
        stage,
        failed_stage,
        failure,
        recording_path,
        recording_mime_type,
        recording_seconds,
        transcript,
        profile,
        ${iso("created_at")} AS created_at
      FROM
        practice_sessions
    `;

    const create = Effect.fn("PracticeStore.create")(
      function* (session: NewSession) {
        const rows = yield* sql`
          INSERT INTO
            practice_sessions ${sql.insert({
              fileName: session.fileName,
              recordingMimeType: session.recordingMimeType,
              recordingPath: session.recordingPath,
              recordingSeconds: session.recordingSeconds,
              stage: "transcribing",
            })}
          ON CONFLICT (singleton) DO NOTHING
          RETURNING
            session_id,
            file_name,
            stage,
            failed_stage,
            failure,
            recording_path,
            recording_mime_type,
            recording_seconds,
            transcript,
            profile,
            ${iso("created_at")} AS created_at
        `.pipe(Effect.flatMap(decodeSessions));
        const created = rows[0];
        if (created === undefined) {
          return yield* new SessionAlreadyExists();
        }
        return created;
      },
      Effect.catchTags({
        SchemaError: (cause) => Effect.fail(storeError(cause)),
        SqlError: (cause) => Effect.fail(storeError(cause)),
      }),
    );

    const current = selectSession.pipe(
      Effect.flatMap(decodeSessions),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(storeError),
      Effect.withSpan("PracticeStore.current"),
    );

    const remove = sql`
      DELETE FROM practice_sessions
      RETURNING
        session_id,
        file_name,
        stage,
        failed_stage,
        failure,
        recording_path,
        recording_mime_type,
        recording_seconds,
        transcript,
        profile,
        ${iso("created_at")} AS created_at
    `.pipe(
      Effect.flatMap(decodeSessions),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(storeError),
      Effect.withSpan("PracticeStore.remove"),
    );

    const saveTranscript = Effect.fn("PracticeStore.saveTranscript")(function* (
      sessionId: SessionId,
      transcript: TranscriptType,
    ) {
      yield* sql`
        UPDATE practice_sessions
        SET
          transcript = ${sql.json(transcript)},
          recording_path = NULL,
          stage = 'analyzing',
          updated_at = clock_timestamp()
        WHERE
          session_id = ${sessionId}
          AND stage = 'transcribing'
      `;
    }, Effect.mapError(storeError));

    const saveProfile = Effect.fn("PracticeStore.saveProfile")(function* (
      sessionId: SessionId,
      profile: SessionProfileType,
    ) {
      yield* sql`
        UPDATE practice_sessions
        SET
          profile = ${sql.json(profile)},
          stage = 'ready',
          updated_at = clock_timestamp()
        WHERE
          session_id = ${sessionId}
          AND stage = 'analyzing'
      `;
    }, Effect.mapError(storeError));

    const fail = Effect.fn("PracticeStore.fail")(function* (
      sessionId: SessionId,
      step: PreparationStep,
      failure: SessionFailureType,
    ) {
      yield* sql`
        UPDATE practice_sessions
        SET
          stage = 'failed',
          failed_stage = ${step},
          failure = ${sql.json(failure)},
          updated_at = clock_timestamp()
        WHERE
          session_id = ${sessionId}
          AND stage = ${step}
      `;
    }, Effect.mapError(storeError));

    const resume = Effect.fn("PracticeStore.resume")(function* (
      sessionId: SessionId,
    ) {
      yield* sql`
        UPDATE practice_sessions
        SET
          stage = failed_stage,
          failed_stage = NULL,
          failure = NULL,
          updated_at = clock_timestamp()
        WHERE
          session_id = ${sessionId}
          AND stage = 'failed'
      `;
    }, Effect.mapError(storeError));

    const counts = (sessionId: SessionId) =>
      sql`
        SELECT
          count(r.sentence_id)::int AS answered,
          count(r.sentence_id) FILTER (
            WHERE
              r.understood
          )::int AS understood,
          count(*) FILTER (
            WHERE
              r.sentence_id IS NULL
              AND s.audio IS NOT NULL
          )::int AS buffered,
          count(*) FILTER (
            WHERE
              r.sentence_id IS NULL
          )::int AS unanswered
        FROM
          practice_sentences s
          LEFT JOIN practice_responses r ON r.sentence_id = s.sentence_id
        WHERE
          s.session_id = ${sessionId}
      `.pipe(
        Effect.flatMap(decodeCounts),
        Effect.map(
          (rows) =>
            rows[0] ?? {
              answered: 0,
              buffered: 0,
              unanswered: 0,
              understood: 0,
            },
        ),
        Effect.mapError(storeError),
      );

    const stats = Effect.fn("PracticeStore.stats")(function* (
      sessionId: SessionId,
    ) {
      const { answered, buffered, understood } = yield* counts(sessionId);
      return { answered, buffered, understood };
    });

    const unansweredCount = Effect.fn("PracticeStore.unansweredCount")(
      function* (sessionId: SessionId) {
        return (yield* counts(sessionId)).unanswered;
      },
    );

    const recentSentences = Effect.fn("PracticeStore.recentSentences")(
      function* (sessionId: SessionId, limit: number) {
        const rows = yield* sql`
          SELECT
            finnish
          FROM
            practice_sentences
          WHERE
            session_id = ${sessionId}
          ORDER BY
            position DESC
          LIMIT
            ${limit}
        `.pipe(Effect.flatMap(decodeFinnish));
        return rows.map((row) => row.finnish);
      },
      Effect.mapError(storeError),
    );

    const recentStruggles = Effect.fn("PracticeStore.recentStruggles")(
      function* (sessionId: SessionId, window: number) {
        return yield* sql`
          SELECT
            sentence_id,
            finnish,
            english
          FROM
            (
              SELECT
                s.sentence_id,
                s.finnish,
                s.english,
                r.understood,
                r.answered_at
              FROM
                practice_responses r
                JOIN practice_sentences s ON s.sentence_id = r.sentence_id
              WHERE
                s.session_id = ${sessionId}
              ORDER BY
                r.answered_at DESC
              LIMIT
                ${window}
            ) recent
          WHERE
            NOT understood
          ORDER BY
            answered_at DESC
        `.pipe(Effect.flatMap(decodeStruggles));
      },
      Effect.mapError(storeError),
    );

    const insertSentences = Effect.fn("PracticeStore.insertSentences")(
      function* (
        sessionId: SessionId,
        drafts: ReadonlyArray<SentenceDraft & { readonly normalized: string }>,
      ) {
        if (drafts.length === 0) {
          return 0;
        }
        // Joining on the session keeps a reset session from gaining rows.
        const rows = yield* sql`
          INSERT INTO
            practice_sentences (session_id, finnish, english, normalized, variation_of)
          SELECT
            s.session_id,
            d.finnish,
            d.english,
            d.normalized,
            d.variation_of::uuid
          FROM
            jsonb_to_recordset(${sql.json(
              drafts.map((draft) => ({
                english: draft.english,
                finnish: draft.finnish,
                normalized: draft.normalized,
                variation_of: draft.variationOf,
              })),
            )}) AS d (finnish text, english text, normalized text, variation_of text)
            JOIN practice_sessions s ON s.session_id = ${sessionId}
          ON CONFLICT (session_id, normalized) DO NOTHING
          RETURNING
            sentence_id
        `;
        return rows.length;
      },
      Effect.mapError(storeError),
    );

    const awaitingAudio = Effect.fn("PracticeStore.awaitingAudio")(function* (
      sessionId: SessionId,
    ) {
      return yield* sql`
        SELECT
          sentence_id,
          finnish
        FROM
          practice_sentences
        WHERE
          session_id = ${sessionId}
          AND audio IS NULL
        ORDER BY
          position
      `.pipe(Effect.flatMap(decodeAwaiting));
    }, Effect.mapError(storeError));

    const saveAudio = Effect.fn("PracticeStore.saveAudio")(function* (
      sentenceId: SentenceId,
      speech: SynthesizedSpeech,
    ) {
      yield* sql`
        UPDATE practice_sentences
        SET
          audio = ${speech.bytes},
          audio_mime_type = ${speech.mimeType}
        WHERE
          sentence_id = ${sentenceId}
      `;
    }, Effect.mapError(storeError));

    const upcoming = Effect.fn("PracticeStore.upcoming")(function* (
      sessionId: SessionId,
      limit: number,
    ) {
      return yield* sql`
        SELECT
          s.sentence_id,
          s.english
        FROM
          practice_sentences s
          LEFT JOIN practice_responses r ON r.sentence_id = s.sentence_id
        WHERE
          s.session_id = ${sessionId}
          AND s.audio IS NOT NULL
          AND r.sentence_id IS NULL
        ORDER BY
          s.position
        LIMIT
          ${limit}
      `.pipe(Effect.flatMap(decodeUpcoming));
    }, Effect.mapError(storeError));

    const audio = Effect.fn("PracticeStore.audio")(function* (
      sentenceId: SentenceId,
    ) {
      const rows = yield* sql`
        SELECT
          audio,
          audio_mime_type
        FROM
          practice_sentences
        WHERE
          sentence_id = ${sentenceId}
          AND audio IS NOT NULL
      `.pipe(Effect.flatMap(decodeAudio));
      return Option.fromNullishOr(rows[0]).pipe(
        Option.map((row): SynthesizedSpeech => ({
          bytes: row.audio,
          mimeType: row.audioMimeType,
        })),
      );
    }, Effect.mapError(storeError));

    const respond = Effect.fn("PracticeStore.respond")(
      function* (sentenceId: SentenceId, response: PracticeResponse) {
        const found = yield* sql`
          SELECT
            r.sentence_id IS NOT NULL AS answered
          FROM
            practice_sentences s
            LEFT JOIN practice_responses r ON r.sentence_id = s.sentence_id
          WHERE
            s.sentence_id = ${sentenceId}
        `.pipe(Effect.flatMap(decodeAnswered));
        const sentence = found[0];
        if (sentence === undefined) {
          return yield* new SentenceNotFound({ sentenceId });
        }
        if (sentence.answered) {
          return yield* new AlreadyAnswered({ sentenceId });
        }
        const inserted = yield* sql`
          INSERT INTO
            practice_responses ${sql.insert({
              replayCount: response.replayCount,
              sentenceId,
              translationRevealed: response.translationRevealed,
              understood: response.understood,
            })}
          ON CONFLICT (sentence_id) DO NOTHING
          RETURNING
            sentence_id
        `;
        // Lost a race with a concurrent answer to the same sentence.
        if (inserted.length === 0) {
          return yield* new AlreadyAnswered({ sentenceId });
        }
      },
      Effect.catchTags({
        SchemaError: (cause) => Effect.fail(storeError(cause)),
        SqlError: (cause) => Effect.fail(storeError(cause)),
      }),
    );

    return PracticeStore.of({
      audio,
      awaitingAudio,
      create,
      current,
      fail,
      insertSentences,
      recentSentences,
      recentStruggles,
      remove,
      respond,
      resume,
      saveAudio,
      saveProfile,
      saveTranscript,
      stats,
      unansweredCount,
      upcoming,
    });
  }),
);

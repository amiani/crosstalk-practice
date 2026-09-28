import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Option, Schema } from "effect";

import {
  AlreadyAnswered,
  SentenceId,
  SentenceNotFound,
} from "../domain/model.ts";
import type { PracticeResponse, SessionId } from "../domain/model.ts";
import {
  PracticeStore,
  PracticeStoreError,
} from "../practice/PracticeStore.ts";
import type { RejectedDraft } from "./CurriculumAuthor.ts";
import type { Observation } from "./CurriculumPolicy.ts";
import { CurriculumStore } from "./CurriculumStore.ts";
import type { NewPlan, WrittenSentence } from "./CurriculumStore.ts";
import { deriveEvidence } from "./evidence.ts";

const Role = Schema.Literals(["teaching", "transfer", "review"]);

const decodeObservations = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      contentKey: Schema.String,
      evidenceId: Schema.String,
      family: Schema.String,
      planSeq: Schema.Finite,
      respondedAt: Schema.Finite,
      role: Role,
      startedPlaybacks: Schema.NullOr(Schema.Int),
      targetId: Schema.String,
      targetRevision: Schema.Int,
      traceComplete: Schema.Boolean,
      translationRevealed: Schema.Boolean,
      understood: Schema.Boolean,
      usable: Schema.NullOr(Schema.Boolean),
    }),
  ),
);
const decodeHistory = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      answered: Schema.Boolean,
      role: Role,
      seq: Schema.Finite,
      targetId: Schema.String,
    }),
  ),
);
const decodeContent = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ contentKey: Schema.String })),
);
const decodeExamples = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      english: Schema.String,
      finnish: Schema.String,
      targetId: Schema.String,
    }),
  ),
);
const decodeOutcomes = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      status: Schema.Literals(["pending", "written", "failed"]),
      targetId: Schema.String,
    }),
  ),
);
const decodeCreated = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ planId: Schema.String, seq: Schema.Finite })),
);
const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Int })),
);
const decodeAwaiting = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ finnish: Schema.String, sentenceId: SentenceId }),
  ),
);
const decodeCandidates = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      english: Schema.String,
      role: Role,
      sentenceId: SentenceId,
      targetId: Schema.String,
    }),
  ),
);
const decodeResponses = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      presentationId: Schema.NullOr(Schema.String),
      replayCount: Schema.Int,
      translationRevealed: Schema.Boolean,
      understood: Schema.Boolean,
    }),
  ),
);
const decodeEvidenceState = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      presentationId: Schema.NullOr(Schema.String),
      responseRevealed: Schema.Boolean,
      startedPlaybacks: Schema.NullOr(Schema.Int),
      traceComplete: Schema.Boolean,
      translationRevealed: Schema.Boolean,
      understood: Schema.Boolean,
      usable: Schema.NullOr(Schema.Boolean),
    }),
  ),
);
const decodeEvents = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      eventType: Schema.String,
      presentationId: Schema.String,
      sequence: Schema.Int,
    }),
  ),
);
const decodeSentenceIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sentenceId: SentenceId })),
);
const decodePlanFound = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ found: Schema.Boolean })),
);

const storeError = (cause: unknown) => new PracticeStoreError({ cause });

const sameResponse = (
  stored: {
    readonly presentationId: string | null;
    readonly replayCount: number;
    readonly translationRevealed: boolean;
    readonly understood: boolean;
  },
  response: PracticeResponse,
) =>
  stored.presentationId === response.presentationId &&
  stored.replayCount === response.replayCount &&
  stored.translationRevealed === response.translationRevealed &&
  stored.understood === response.understood;

export const curriculumStorePostgres = Layer.effect(
  CurriculumStore,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const practice = yield* PracticeStore;

    const epochMs = (column: string) =>
      sql.literal(`(extract(epoch FROM ${column}) * 1000)::float8`);

    const observations = sql`
      SELECT
        evidence_id::text,
        plan_seq::float8,
        target_id,
        target_revision,
        role,
        family,
        content_key,
        understood,
        translation_revealed,
        started_playbacks,
        trace_complete,
        usable,
        ${epochMs("responded_at")} AS responded_at
      FROM
        curriculum_evidence
      ORDER BY
        -- Qualified: the bare name would sort by the text output column.
        curriculum_evidence.evidence_id
    `.pipe(
      Effect.flatMap(decodeObservations),
      Effect.map((rows) =>
        rows.map((row, order): Observation => ({
          contentKey: row.contentKey,
          family: row.family,
          order,
          position: row.planSeq,
          respondedAt: row.respondedAt,
          role: row.role,
          sentenceId: row.evidenceId,
          startedPlaybacks: row.startedPlaybacks,
          targetId: row.targetId,
          targetRevision: row.targetRevision,
          traceComplete: row.traceComplete,
          translationRevealed: row.translationRevealed,
          understood: row.understood,
          usable: row.usable,
        })),
      ),
      Effect.mapError(storeError),
      Effect.withSpan("CurriculumStore.observations"),
    );

    const history = Effect.fn("CurriculumStore.history")(function* (
      sessionId: SessionId,
    ) {
      return yield* sql`
        SELECT
          p.seq::float8,
          p.role,
          p.target_id,
          r.sentence_id IS NOT NULL AS answered
        FROM
          curriculum_plans p
          LEFT JOIN practice_responses r ON r.sentence_id = p.sentence_id
        WHERE
          p.session_id = ${sessionId}
          AND p.status IN ('pending', 'written')
        ORDER BY
          p.seq
      `.pipe(Effect.flatMap(decodeHistory));
    }, Effect.mapError(storeError));

    const usedContent = Effect.fn("CurriculumStore.usedContent")(function* (
      targetId: string,
    ) {
      const rows = yield* sql`
        SELECT
          content_key
        FROM
          curriculum_evidence
        WHERE
          target_id = ${targetId}
        UNION
        SELECT
          content_key
        FROM
          curriculum_plans
        WHERE
          target_id = ${targetId}
          AND content_key IS NOT NULL
      `.pipe(Effect.flatMap(decodeContent));
      return rows.map((row) => row.contentKey);
    }, Effect.mapError(storeError));

    const recentExamples = Effect.fn("CurriculumStore.recentExamples")(
      function* (sessionId: SessionId, limit: number) {
        return yield* sql`
          SELECT
            s.finnish,
            s.english,
            p.target_id
          FROM
            curriculum_plans p
            JOIN practice_sentences s ON s.sentence_id = p.sentence_id
          WHERE
            p.session_id = ${sessionId}
          ORDER BY
            p.seq DESC
          LIMIT
            ${limit}
        `.pipe(Effect.flatMap(decodeExamples));
      },
      Effect.mapError(storeError),
    );

    const targetExamples = Effect.fn("CurriculumStore.targetExamples")(
      function* (sessionId: SessionId, targetId: string, limit: number) {
        return yield* sql`
          SELECT
            s.finnish,
            s.english,
            p.target_id
          FROM
            curriculum_plans p
            JOIN practice_sentences s ON s.sentence_id = p.sentence_id
          WHERE
            p.session_id = ${sessionId}
            AND p.target_id = ${targetId}
          ORDER BY
            p.seq DESC
          LIMIT
            ${limit}
        `.pipe(Effect.flatMap(decodeExamples));
      },
      Effect.mapError(storeError),
    );

    const recentPlans = Effect.fn("CurriculumStore.recentPlans")(function* (
      sessionId: SessionId,
      limit: number,
    ) {
      return yield* sql`
        SELECT
          status,
          target_id
        FROM
          curriculum_plans
        WHERE
          session_id = ${sessionId}
        ORDER BY
          seq DESC
        LIMIT
          ${limit}
      `.pipe(Effect.flatMap(decodeOutcomes));
    }, Effect.mapError(storeError));

    const abandonPending = Effect.fn("CurriculumStore.abandonPending")(
      function* (sessionId: SessionId) {
        yield* sql`
          UPDATE curriculum_plans
          SET
            status = 'failed'
          WHERE
            session_id = ${sessionId}
            AND status = 'pending'
        `;
      },
      Effect.mapError(storeError),
    );

    const createPlan = Effect.fn("CurriculumStore.createPlan")(function* (
      sessionId: SessionId,
      plan: NewPlan,
    ) {
      // Selecting from the session keeps a reset session from gaining plans.
      const rows = yield* sql`
        INSERT INTO
          curriculum_plans (
            session_id,
            status,
            catalog_version,
            target_id,
            target_revision,
            role,
            easier,
            family,
            reason,
            decision,
            model_version,
            selection_version,
            author_version
          )
        SELECT
          session_id,
          'pending',
          ${plan.catalogVersion},
          ${plan.plan.targetId},
          ${plan.plan.targetRevision},
          ${plan.plan.role},
          ${plan.plan.easier},
          ${plan.family},
          ${plan.plan.reason},
          ${sql.json(plan.decision)},
          ${plan.modelVersion},
          ${plan.selectionVersion},
          ${plan.authorVersion}
        FROM
          practice_sessions
        WHERE
          session_id = ${sessionId}
        RETURNING
          plan_id::text,
          seq::float8
      `.pipe(Effect.flatMap(decodeCreated));
      return Option.fromNullishOr(rows[0]);
    }, Effect.mapError(storeError));

    const failPlan = Effect.fn("CurriculumStore.failPlan")(function* (
      planId: string,
      rejections: ReadonlyArray<RejectedDraft>,
    ) {
      yield* sql`
        UPDATE curriculum_plans
        SET
          status = 'failed',
          rejections = ${sql.json(rejections)}
        WHERE
          plan_id = ${planId}
          AND status = 'pending'
      `;
    }, Effect.mapError(storeError));

    const writeSentence = Effect.fn("CurriculumStore.writeSentence")(
      function* (planId: string, sentence: WrittenSentence) {
        const inserted = yield* sql`
          INSERT INTO
            practice_sentences (session_id, finnish, english, normalized, track, generation_policy)
          SELECT
            session_id,
            ${sentence.finnish},
            ${sentence.english},
            ${sentence.normalized},
            'curriculum',
            author_version
          FROM
            curriculum_plans
          WHERE
            plan_id = ${planId}
            AND status = 'pending'
          ON CONFLICT (session_id, normalized) DO NOTHING
          RETURNING
            sentence_id
        `.pipe(Effect.flatMap(decodeSentenceIds));
        const row = inserted[0];
        if (row === undefined) {
          return Option.none();
        }
        yield* sql`
          UPDATE curriculum_plans
          SET
            status = 'written',
            sentence_id = ${row.sentenceId},
            content_key = ${sentence.contentKey},
            realisation = ${sentence.realisation},
            review_note = ${sentence.reviewNote},
            rejections = ${sql.json(sentence.rejections)}
          WHERE
            plan_id = ${planId}
        `;
        return Option.some(row.sentenceId);
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const unansweredCount = Effect.fn("CurriculumStore.unansweredCount")(
      function* (sessionId: SessionId, catalogVersion: string) {
        const rows = yield* sql`
          SELECT
            count(*)::int AS count
          FROM
            curriculum_plans p
            LEFT JOIN practice_responses r ON r.sentence_id = p.sentence_id
          WHERE
            p.session_id = ${sessionId}
            AND p.status = 'written'
            AND p.catalog_version = ${catalogVersion}
            AND r.sentence_id IS NULL
        `.pipe(Effect.flatMap(decodeCount));
        return rows[0]?.count ?? 0;
      },
      Effect.mapError(storeError),
    );

    const awaitingAudio = Effect.fn("CurriculumStore.awaitingAudio")(function* (
      sessionId: SessionId,
    ) {
      return yield* sql`
        SELECT
          s.sentence_id,
          s.finnish
        FROM
          practice_sentences s
          LEFT JOIN practice_responses r ON r.sentence_id = s.sentence_id
        WHERE
          s.session_id = ${sessionId}
          AND s.track = 'curriculum'
          AND s.audio IS NULL
          AND r.sentence_id IS NULL
        ORDER BY
          s.position
      `.pipe(Effect.flatMap(decodeAwaiting));
    }, Effect.mapError(storeError));

    const candidates = Effect.fn("CurriculumStore.candidates")(function* (
      sessionId: SessionId,
      catalogVersion: string,
    ) {
      return yield* sql`
        SELECT
          s.sentence_id,
          s.english,
          p.role,
          p.target_id
        FROM
          curriculum_plans p
          JOIN practice_sentences s ON s.sentence_id = p.sentence_id
          LEFT JOIN practice_responses r ON r.sentence_id = p.sentence_id
        WHERE
          p.session_id = ${sessionId}
          AND p.catalog_version = ${catalogVersion}
          AND s.audio IS NOT NULL
          AND r.sentence_id IS NULL
        ORDER BY
          p.seq
      `.pipe(Effect.flatMap(decodeCandidates));
    }, Effect.mapError(storeError));

    const refreshEvidence = Effect.fn("CurriculumStore.refreshEvidence")(
      function* (sentenceId: SentenceId) {
        const states = yield* sql`
          SELECT
            r.presentation_id::text,
            r.translation_revealed AS response_revealed,
            e.understood,
            e.translation_revealed,
            e.started_playbacks,
            e.trace_complete,
            e.usable
          FROM
            curriculum_evidence e
            JOIN practice_responses r ON r.sentence_id = e.sentence_id
          WHERE
            e.sentence_id = ${sentenceId}
          FOR UPDATE OF
            e
        `.pipe(Effect.flatMap(decodeEvidenceState));
        const state = states[0];
        if (state === undefined) {
          return false;
        }
        const events = yield* sql`
          SELECT
            e.presentation_id::text,
            e.sequence,
            e.event_type
          FROM
            practice_presentation_events e
            JOIN practice_presentations p ON p.presentation_id = e.presentation_id
          WHERE
            p.sentence_id = ${sentenceId}
        `.pipe(Effect.flatMap(decodeEvents));
        const derived = deriveEvidence(
          {
            presentationId: state.presentationId,
            translationRevealed: state.responseRevealed,
            understood: state.understood,
          },
          events,
        );
        if (
          derived.startedPlaybacks === state.startedPlaybacks &&
          derived.traceComplete === state.traceComplete &&
          derived.translationRevealed === state.translationRevealed &&
          derived.usable === state.usable
        ) {
          return false;
        }
        yield* sql`
          UPDATE curriculum_evidence
          SET
            started_playbacks = ${derived.startedPlaybacks},
            trace_complete = ${derived.traceComplete},
            translation_revealed = ${derived.translationRevealed},
            usable = ${derived.usable},
            revision = revision + 1,
            updated_at = clock_timestamp()
          WHERE
            sentence_id = ${sentenceId}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(storeError),
    );

    const refreshIncomplete = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT
          sentence_id
        FROM
          curriculum_evidence
        WHERE
          sentence_id IS NOT NULL
          AND NOT trace_complete
      `.pipe(Effect.flatMap(decodeSentenceIds), Effect.mapError(storeError));
      const changed = yield* Effect.forEach(rows, (row) =>
        refreshEvidence(row.sentenceId),
      );
      return changed.filter(Boolean).length;
    }).pipe(Effect.withSpan("CurriculumStore.refreshIncomplete"));

    const insertEvidence = (sentenceId: SentenceId) => sql`
      INSERT INTO
        curriculum_evidence (
          sentence_id,
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
        s.sentence_id,
        p.seq,
        p.catalog_version,
        p.target_id,
        p.target_revision,
        p.role,
        p.family,
        coalesce(p.content_key, ''),
        s.finnish,
        s.english,
        r.understood,
        r.translation_revealed,
        FALSE,
        r.answered_at
      FROM
        practice_sentences s
        JOIN curriculum_plans p ON p.sentence_id = s.sentence_id
        JOIN practice_responses r ON r.sentence_id = s.sentence_id
      WHERE
        s.sentence_id = ${sentenceId}
      ON CONFLICT (sentence_id) DO NOTHING
    `;

    const storedResponse = (sentenceId: SentenceId) =>
      sql`
        SELECT
          presentation_id::text,
          replay_count,
          translation_revealed,
          understood
        FROM
          practice_responses
        WHERE
          sentence_id = ${sentenceId}
      `.pipe(
        Effect.flatMap(decodeResponses),
        Effect.map((rows) => rows[0]),
      );

    const respond = Effect.fn("CurriculumStore.respond")(
      function* (sentenceId: SentenceId, response: PracticeResponse) {
        const plans = yield* sql`
          SELECT
            TRUE AS found
          FROM
            curriculum_plans
          WHERE
            sentence_id = ${sentenceId}
        `.pipe(Effect.flatMap(decodePlanFound));
        if (plans.length === 0) {
          return yield* new SentenceNotFound({ sentenceId });
        }
        const existing = yield* storedResponse(sentenceId);
        if (existing === undefined) {
          yield* practice.respond(sentenceId, response).pipe(
            // A concurrent identical resend won the race: that is fine.
            Effect.catchTag("AlreadyAnswered", (error) =>
              storedResponse(sentenceId).pipe(
                Effect.flatMap((stored) =>
                  stored !== undefined && sameResponse(stored, response)
                    ? Effect.void
                    : Effect.fail(error),
                ),
              ),
            ),
          );
        } else if (!sameResponse(existing, response)) {
          return yield* new AlreadyAnswered({ sentenceId });
        }
        yield* insertEvidence(sentenceId);
        yield* refreshEvidence(sentenceId);
      },
      sql.withTransaction,
      Effect.catchTags({
        SchemaError: (cause) => Effect.fail(storeError(cause)),
        SqlError: (cause) => Effect.fail(storeError(cause)),
      }),
    );

    const clear = sql`
      DELETE FROM curriculum_evidence
    `.pipe(
      Effect.asVoid,
      Effect.mapError(storeError),
      Effect.withSpan("CurriculumStore.clear"),
    );

    return CurriculumStore.of({
      abandonPending,
      awaitingAudio,
      candidates,
      clear,
      createPlan,
      failPlan,
      history,
      observations,
      recentExamples,
      recentPlans,
      refreshEvidence,
      refreshIncomplete,
      respond,
      targetExamples,
      unansweredCount,
      usedContent,
      writeSentence,
    });
  }),
);

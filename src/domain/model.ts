import { Schema } from "effect";

/**
 * Domain vocabulary shared by the server and the browser. Nothing here may
 * import server-only modules: the web client bundles this file.
 */

export const SessionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

export const SentenceId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("SentenceId"),
);
export type SentenceId = typeof SentenceId.Type;

// ---------------------------------------------------------------------------
// Transcript: what the speech-to-text step heard, before any interpretation.
// ---------------------------------------------------------------------------

/** One uninterrupted stretch of speech by one speaker. */
export const TranscriptTurn = Schema.Struct({
  /** False when the transcriber doubts what it heard. */
  clear: Schema.optionalKey(Schema.Boolean),
  /** Language code such as "fi" or "en", when the transcriber reports it. */
  language: Schema.optionalKey(Schema.String),
  /** Speaker label ("native_speaker", "learner", "spk_1"); null if unknown. */
  speaker: Schema.NullOr(Schema.String),
  text: Schema.String,
});
export type TranscriptTurn = typeof TranscriptTurn.Type;

export const Transcript = Schema.Struct({
  /** Provider/model that produced the transcript, for debugging. */
  source: Schema.String,
  text: Schema.String,
  turns: Schema.Array(TranscriptTurn),
});
export type Transcript = typeof Transcript.Type;

// ---------------------------------------------------------------------------
// Session profile: the stable boundary every generated sentence stays within.
// ---------------------------------------------------------------------------

export const FinnishUtterance = Schema.Struct({
  english: Schema.String,
  finnish: Schema.String,
});
export type FinnishUtterance = typeof FinnishUtterance.Type;

export const VocabularyItem = Schema.Struct({
  english: Schema.String,
  /** The form(s) heard in the session. */
  heard: Schema.String,
  lemma: Schema.String,
});
export type VocabularyItem = typeof VocabularyItem.Type;

export const Construction = Schema.Struct({
  description: Schema.String,
  example: Schema.String,
});
export type Construction = typeof Construction.Type;

export const SessionProfile = Schema.Struct({
  constructions: Schema.Array(Construction),
  /** Finnish snippets dropped because the transcript looked unreliable. */
  discardedSnippets: Schema.Int,
  /** How the Finnish speaker talked: colloquial forms, pace, formality. */
  register: Schema.String,
  /** English summary of what the conversation was about. */
  summary: Schema.String,
  topics: Schema.Array(Schema.String),
  /** Finnish the learner reliably heard, with translations. */
  utterances: Schema.Array(FinnishUtterance),
  vocabulary: Schema.Array(VocabularyItem),
});
export type SessionProfile = typeof SessionProfile.Type;

// ---------------------------------------------------------------------------
// Session lifecycle as seen by the learner.
// ---------------------------------------------------------------------------

export const PreparationStage = Schema.Literals([
  /** Speech-to-text is running on the uploaded recording. */
  "transcribing",
  /** The transcript is being turned into a session profile. */
  "analyzing",
  /** The profile exists; the first practice sentences are being made. */
  "generating",
]);
export type PreparationStage = typeof PreparationStage.Type;

export const FailureReason = Schema.Literals([
  "transcription_failed",
  "analysis_failed",
  "insufficient_material",
]);
export type FailureReason = typeof FailureReason.Type;

export const SessionFailure = Schema.Struct({
  message: Schema.String,
  reason: FailureReason,
  /** Whether retrying the failed step could plausibly succeed. */
  retryable: Schema.Boolean,
});
export type SessionFailure = typeof SessionFailure.Type;

export const PracticeStats = Schema.Struct({
  answered: Schema.Int,
  /** Sentences with audio, waiting to be practiced. */
  buffered: Schema.Int,
  understood: Schema.Int,
});
export type PracticeStats = typeof PracticeStats.Type;

const SessionSummary = {
  createdAt: Schema.String,
  fileName: Schema.String,
  sessionId: SessionId,
};

export const SessionView = Schema.Union([
  Schema.TaggedStruct("NoSession", {}),
  Schema.TaggedStruct("Preparing", {
    ...SessionSummary,
    stage: PreparationStage,
  }),
  Schema.TaggedStruct("Failed", {
    ...SessionSummary,
    failure: SessionFailure,
  }),
  Schema.TaggedStruct("Ready", {
    ...SessionSummary,
    stats: PracticeStats,
    summary: Schema.String,
    topics: Schema.Array(Schema.String),
  }),
]);
export type SessionView = typeof SessionView.Type;

// ---------------------------------------------------------------------------
// Practice.
// ---------------------------------------------------------------------------

/** A sentence ready to be heard. The Finnish text is deliberately absent. */
export const PracticeItem = Schema.Struct({
  audioUrl: Schema.String,
  english: Schema.String,
  sentenceId: SentenceId,
});
export type PracticeItem = typeof PracticeItem.Type;

export const PracticeResponse = Schema.Struct({
  replayCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  translationRevealed: Schema.Boolean,
  understood: Schema.Boolean,
});
export type PracticeResponse = typeof PracticeResponse.Type;

// ---------------------------------------------------------------------------
// Errors that cross the HTTP boundary.
// ---------------------------------------------------------------------------

export class SessionAlreadyExists extends Schema.TaggedError<SessionAlreadyExists>()(
  "SessionAlreadyExists",
  {},
  { httpApiStatus: 409 },
) {}

export class NoActiveSession extends Schema.TaggedError<NoActiveSession>()(
  "NoActiveSession",
  {},
  { httpApiStatus: 409 },
) {}

export class RecordingRejected extends Schema.TaggedError<RecordingRejected>()(
  "RecordingRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class NotRetryable extends Schema.TaggedError<NotRetryable>()(
  "NotRetryable",
  {},
  { httpApiStatus: 409 },
) {}

export class SentenceNotFound extends Schema.TaggedError<SentenceNotFound>()(
  "SentenceNotFound",
  { sentenceId: Schema.String },
  { httpApiStatus: 404 },
) {}

export class AlreadyAnswered extends Schema.TaggedError<AlreadyAnswered>()(
  "AlreadyAnswered",
  { sentenceId: Schema.String },
  { httpApiStatus: 409 },
) {}

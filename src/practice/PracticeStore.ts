import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type {
  AlreadyAnswered,
  PracticeResponse,
  PracticeStats,
  SentenceId,
  SentenceNotFound,
  SessionAlreadyExists,
  SessionFailure,
  SessionId,
  SessionProfile,
  Transcript,
} from "../domain/model.ts";
import type { SynthesizedSpeech } from "../speech/SpeechSynthesizer.ts";
import type { SentenceDraft, Struggle } from "./SentenceAuthor.ts";

export type SessionStage = "transcribing" | "analyzing" | "ready" | "failed";
export type PreparationStep = "transcribing" | "analyzing";

/**
 * The active session as stored. Stage invariants (enforced by the schema):
 * `analyzing` and `ready` have a transcript, `ready` has a profile, and
 * `failed` records the step that failed and why.
 */
export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly fileName: string;
  readonly stage: SessionStage;
  readonly failedStage: PreparationStep | null;
  readonly failure: SessionFailure | null;
  /** Present until transcription succeeds; the audio is then deleted. */
  readonly recordingPath: string | null;
  readonly recordingMimeType: string;
  readonly recordingSeconds: number;
  readonly transcript: Transcript | null;
  readonly profile: SessionProfile | null;
  readonly createdAt: string;
}

export interface NewSession {
  readonly fileName: string;
  readonly recordingPath: string;
  readonly recordingMimeType: string;
  readonly recordingSeconds: number;
}

export interface UpcomingSentence {
  readonly sentenceId: SentenceId;
  readonly english: string;
}

export interface SentenceAwaitingAudio {
  readonly sentenceId: SentenceId;
  readonly finnish: string;
}

export class PracticeStoreError extends Schema.TaggedError<PracticeStoreError>()(
  "PracticeStoreError",
  { cause: Schema.Defect() },
) {}

type Stored<A, E = never> = Effect.Effect<A, E | PracticeStoreError>;

/**
 * Durable state of the (single) practice session: preparation progress,
 * generated sentences with their audio, and the learner's responses.
 * Writes addressed to a session that no longer exists are silently ignored,
 * so background work racing a reset cannot resurrect anything.
 */
export class PracticeStore extends Context.Service<
  PracticeStore,
  {
    readonly create: (
      session: NewSession,
    ) => Stored<SessionRecord, SessionAlreadyExists>;
    readonly current: Stored<Option.Option<SessionRecord>>;
    /** Deletes the session and everything generated from it. */
    readonly remove: Stored<Option.Option<SessionRecord>>;

    /** Records the transcript and forgets the (now deleted) recording. */
    readonly saveTranscript: (
      sessionId: SessionId,
      transcript: Transcript,
    ) => Stored<void>;
    readonly saveProfile: (
      sessionId: SessionId,
      profile: SessionProfile,
    ) => Stored<void>;
    readonly fail: (
      sessionId: SessionId,
      step: PreparationStep,
      failure: SessionFailure,
    ) => Stored<void>;
    /** Returns a failed session to the step that failed. */
    readonly resume: (sessionId: SessionId) => Stored<void>;

    readonly stats: (sessionId: SessionId) => Stored<PracticeStats>;
    /** Sentences generated but not yet answered, with or without audio. */
    readonly unansweredCount: (sessionId: SessionId) => Stored<number>;
    readonly recentSentences: (
      sessionId: SessionId,
      limit: number,
    ) => Stored<ReadonlyArray<string>>;
    /** Failures among the learner's most recent `window` responses. */
    readonly recentStruggles: (
      sessionId: SessionId,
      window: number,
    ) => Stored<ReadonlyArray<Struggle>>;
    /**
     * Stores drafts, skipping any whose normalized text already exists in
     * the session. Returns how many were new.
     */
    readonly insertSentences: (
      sessionId: SessionId,
      drafts: ReadonlyArray<SentenceDraft & { readonly normalized: string }>,
    ) => Stored<number>;
    readonly awaitingAudio: (
      sessionId: SessionId,
    ) => Stored<ReadonlyArray<SentenceAwaitingAudio>>;
    readonly saveAudio: (
      sentenceId: SentenceId,
      speech: SynthesizedSpeech,
    ) => Stored<void>;

    /** Unanswered sentences with audio, oldest first. */
    readonly upcoming: (
      sessionId: SessionId,
      limit: number,
    ) => Stored<ReadonlyArray<UpcomingSentence>>;
    readonly audio: (
      sentenceId: SentenceId,
    ) => Stored<Option.Option<SynthesizedSpeech>>;
    readonly respond: (
      sentenceId: SentenceId,
      response: PracticeResponse,
    ) => Stored<void, SentenceNotFound | AlreadyAnswered>;
  }
>()("crosstalk-practice/practice/PracticeStore") {}

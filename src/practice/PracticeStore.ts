import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type {
  AlreadyAnswered,
  PracticeMode,
  PracticeResponse,
  PracticeStats,
  PracticeTrack,
  PresentationConflict,
  PresentationEvent,
  PresentationId,
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
  /** The mode new sentences are written in; the learner may change it. */
  readonly mode: PracticeMode;
  /** The practice new sentences are served from; the learner may change it. */
  readonly track: PracticeTrack;
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
  readonly mode: PracticeMode;
  readonly track: PracticeTrack;
  readonly recordingPath: string;
  readonly recordingMimeType: string;
  readonly recordingSeconds: number;
}

export interface UpcomingSentence {
  readonly sentenceId: SentenceId;
  readonly english: string;
  readonly mode: PracticeMode;
  readonly track: "crosstalk";
}

/** The rules a batch of sentences was written under; stored with each. */
export interface GenerationPolicy {
  readonly mode: PracticeMode;
  readonly version: string;
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
    /**
     * Changes the mode future sentences are written and served in. Existing
     * sentences, responses and presentations are untouched.
     */
    readonly setMode: (
      sessionId: SessionId,
      mode: PracticeMode,
    ) => Stored<void>;
    /** Changes the track future sentences are written and served in. */
    readonly setTrack: (
      sessionId: SessionId,
      track: PracticeTrack,
    ) => Stored<void>;

    /** Answer counts, and voiced unanswered sentences of every mode and track. */
    readonly stats: (sessionId: SessionId) => Stored<PracticeStats>;
    /**
     * Crosstalk sentences of a mode generated but not yet answered, with or
     * without audio. (Every crosstalk query below ignores curriculum
     * sentences, which have no mode.)
     */
    readonly unansweredCount: (
      sessionId: SessionId,
      mode: PracticeMode,
    ) => Stored<number>;
    /** The latest crosstalk sentences of every mode, to discourage near-repeats. */
    readonly recentSentences: (
      sessionId: SessionId,
      limit: number,
    ) => Stored<ReadonlyArray<string>>;
    /** Failures among the learner's most recent `window` crosstalk responses. */
    readonly recentStruggles: (
      sessionId: SessionId,
      window: number,
    ) => Stored<ReadonlyArray<Struggle>>;
    /**
     * Stores drafts, skipping any whose normalized text already exists in
     * the session in any mode or track. Returns how many were new.
     */
    readonly insertSentences: (
      sessionId: SessionId,
      policy: GenerationPolicy,
      drafts: ReadonlyArray<SentenceDraft & { readonly normalized: string }>,
    ) => Stored<number>;
    /** Sentences of a mode still waiting for audio, oldest first. */
    readonly awaitingAudio: (
      sessionId: SessionId,
      mode: PracticeMode,
    ) => Stored<ReadonlyArray<SentenceAwaitingAudio>>;
    readonly saveAudio: (
      sentenceId: SentenceId,
      speech: SynthesizedSpeech,
    ) => Stored<void>;

    /** Unanswered sentences of a mode with audio, oldest first. */
    readonly upcoming: (
      sessionId: SessionId,
      mode: PracticeMode,
      limit: number,
    ) => Stored<ReadonlyArray<UpcomingSentence>>;
    readonly audio: (
      sentenceId: SentenceId,
    ) => Stored<Option.Option<SynthesizedSpeech>>;
    /**
     * Stores the response and links it to its presentation, claiming the
     * presentation for this sentence if no event has arrived yet.
     */
    readonly respond: (
      sentenceId: SentenceId,
      response: PracticeResponse,
    ) => Stored<
      void,
      SentenceNotFound | AlreadyAnswered | PresentationConflict
    >;
    /**
     * Appends presentation events. Resent event ids are ignored; a
     * presentation belongs to the first sentence that used it.
     */
    readonly recordPresentationEvents: (
      sentenceId: SentenceId,
      presentationId: PresentationId,
      events: ReadonlyArray<PresentationEvent>,
    ) => Stored<void, SentenceNotFound | PresentationConflict>;
  }
>()("crosstalk-practice/practice/PracticeStore") {}

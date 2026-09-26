import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type {
  SentenceId,
  SessionProfile,
  Transcript,
} from "../domain/model.ts";

/** A sentence the learner recently failed to understand. */
export interface Struggle {
  readonly sentenceId: SentenceId;
  readonly finnish: string;
  readonly english: string;
}

export interface SentenceBrief {
  readonly profile: SessionProfile;
  readonly count: number;
  /** Recently generated Finnish, to steer away from near-repeats. */
  readonly recent: ReadonlyArray<string>;
  /** Recent failures that should inspire simpler variations. */
  readonly struggles: ReadonlyArray<Struggle>;
}

export interface SentenceDraft {
  readonly finnish: string;
  readonly english: string;
  /** The struggle this sentence is a simpler variation of, if any. */
  readonly variationOf: SentenceId | null;
}

export class AuthoringError extends Schema.TaggedError<AuthoringError>()(
  "AuthoringError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

/**
 * The language expertise of the system: turning a noisy bilingual transcript
 * into a session profile, and writing new sentences within that profile.
 * Drafts are already vetted; questionable ones never leave this service.
 */
export class SentenceAuthor extends Context.Service<
  SentenceAuthor,
  {
    readonly profileSession: (
      transcript: Transcript,
    ) => Effect.Effect<SessionProfile, AuthoringError>;
    readonly writeSentences: (
      brief: SentenceBrief,
    ) => Effect.Effect<ReadonlyArray<SentenceDraft>, AuthoringError>;
  }
>()("crosstalk-practice/practice/SentenceAuthor") {}

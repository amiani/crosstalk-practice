import { Context } from "effect";
import type { Effect, Option } from "effect";

import type {
  AlreadyAnswered,
  PracticeResponse,
  PresentationConflict,
  SentenceId,
  SentenceNotFound,
  SessionId,
} from "../domain/model.ts";
import type { PracticeStoreError } from "../practice/PracticeStore.ts";
import type { RecentExample, RejectedDraft } from "./CurriculumAuthor.ts";
import type {
  Observation,
  SentencePlan,
  SentenceRole,
} from "./CurriculumPolicy.ts";

type Stored<A, E = never> = Effect.Effect<A, E | PracticeStoreError>;

/** A plan as the scheduler sees its history: served or waiting to be. */
export interface PlannedSelection {
  /** Whether the plan's sentence has been answered. */
  readonly answered: boolean;
  readonly role: SentenceRole;
  readonly seq: number;
  readonly targetId: string;
}

/** A plan's outcome so far, for passing over targets that keep failing. */
export interface PlanOutcome {
  readonly status: "pending" | "written" | "failed";
  readonly targetId: string;
}

/** Everything recorded about why a sentence is being written. */
export interface NewPlan {
  readonly authorVersion: string;
  readonly catalogVersion: string;
  /** Snapshot for auditing: estimates, active set, policies. Never read back. */
  readonly decision: unknown;
  readonly family: string;
  readonly modelVersion: string;
  readonly plan: SentencePlan;
  readonly selectionVersion: string;
}

export interface WrittenSentence {
  readonly contentKey: string;
  readonly english: string;
  readonly finnish: string;
  readonly normalized: string;
  readonly realisation: string;
  /** Drafts rejected on the way to this one. */
  readonly rejections: ReadonlyArray<RejectedDraft>;
  readonly reviewNote: string;
}

/** A voiced, unanswered curriculum sentence that could be served next. */
export interface CurriculumCandidate {
  readonly english: string;
  readonly role: SentenceRole;
  readonly sentenceId: SentenceId;
  readonly targetId: string;
}

export interface CurriculumSentenceAwaitingAudio {
  readonly finnish: string;
  readonly sentenceId: SentenceId;
}

/**
 * Curriculum plans (per recording) and curriculum evidence (per learner,
 * surviving a replaced recording). Plans and sentences for a session that
 * no longer exists are silently not written.
 */
export class CurriculumStore extends Context.Service<
  CurriculumStore,
  {
    /** Every curriculum response, in response order, as model input. */
    readonly observations: Stored<ReadonlyArray<Observation>>;
    /** The session's plans that are written or being written, oldest first. */
    readonly history: (
      sessionId: SessionId,
    ) => Stored<ReadonlyArray<PlannedSelection>>;
    /** Content combinations already used for a target, in any recording. */
    readonly usedContent: (targetId: string) => Stored<ReadonlyArray<string>>;
    /** The latest curriculum sentences of the session, newest first. */
    readonly recentExamples: (
      sessionId: SessionId,
      limit: number,
    ) => Stored<ReadonlyArray<RecentExample>>;
    /** The session's latest sentences for one target, newest first. */
    readonly targetExamples: (
      sessionId: SessionId,
      targetId: string,
      limit: number,
    ) => Stored<ReadonlyArray<RecentExample>>;
    /** The session's latest plans of any status, newest first. */
    readonly recentPlans: (
      sessionId: SessionId,
      limit: number,
    ) => Stored<ReadonlyArray<PlanOutcome>>;
    /** Marks plans left pending by an interrupted pass as failed. */
    readonly abandonPending: (sessionId: SessionId) => Stored<void>;
    /** Stores a pending plan; None if the session is gone. */
    readonly createPlan: (
      sessionId: SessionId,
      plan: NewPlan,
    ) => Stored<
      Option.Option<{ readonly planId: string; readonly seq: number }>
    >;
    /** Marks a pending plan failed, recording why its drafts were rejected. */
    readonly failPlan: (
      planId: string,
      rejections: ReadonlyArray<RejectedDraft>,
    ) => Stored<void>;
    /**
     * Stores the plan's sentence and marks the plan written. None when the
     * sentence duplicates one in the session or the plan is no longer pending.
     */
    readonly writeSentence: (
      planId: string,
      sentence: WrittenSentence,
    ) => Stored<Option.Option<SentenceId>>;
    /** Unanswered curriculum sentences of the catalog version, voiced or not. */
    readonly unansweredCount: (
      sessionId: SessionId,
      catalogVersion: string,
    ) => Stored<number>;
    readonly awaitingAudio: (
      sessionId: SessionId,
    ) => Stored<ReadonlyArray<CurriculumSentenceAwaitingAudio>>;
    /** Voiced, unanswered curriculum sentences of the catalog version, oldest first. */
    readonly candidates: (
      sessionId: SessionId,
      catalogVersion: string,
    ) => Stored<ReadonlyArray<CurriculumCandidate>>;
    /**
     * Stores a response to a curriculum sentence and its evidence. Resending
     * the same response succeeds; a different one fails with AlreadyAnswered.
     */
    readonly respond: (
      sentenceId: SentenceId,
      response: PracticeResponse,
    ) => Stored<
      void,
      SentenceNotFound | AlreadyAnswered | PresentationConflict
    >;
    /**
     * Recomputes a sentence's evidence from its response and events; true if
     * it changed. No-op for sentences without curriculum evidence.
     */
    readonly refreshEvidence: (sentenceId: SentenceId) => Stored<boolean>;
    /** Refreshes all evidence whose trace is still incomplete; returns how many changed. */
    readonly refreshIncomplete: Stored<number>;
    /** Deletes all curriculum evidence: part of starting over. */
    readonly clear: Stored<void>;
  }
>()("crosstalk-practice/curriculum/CurriculumStore") {}

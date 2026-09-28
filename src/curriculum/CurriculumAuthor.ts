import { Context } from "effect";
import type { Effect } from "effect";

import type { VocabularyItem } from "../domain/model.ts";
import type { AuthoringError } from "../practice/SentenceAuthor.ts";
import type { BackgroundGrammar, LearningTarget } from "./Catalog.ts";
import type { SentencePlan } from "./CurriculumPolicy.ts";

/**
 * Identifies the curriculum writer and reviewer instructions; stored with
 * every curriculum sentence. Bump on any meaningful prompt change.
 */
export const CURRICULUM_AUTHOR_VERSION = "curriculum-author-v3";

/** A recent curriculum sentence, so new ones vary rather than repeat. */
export interface RecentExample {
  readonly english: string;
  readonly finnish: string;
  readonly targetId: string;
}

/** Everything the author needs to realise one sentence plan. */
export interface CurriculumBrief {
  readonly plan: SentencePlan;
  /** The primary target the sentence must isolate. */
  readonly target: LearningTarget;
  /** Targets the sentence may use as supporting constructions. */
  readonly supporting: ReadonlyArray<LearningTarget>;
  /** Unassessed grammar the sentence may use. */
  readonly background: ReadonlyArray<BackgroundGrammar>;
  /** Familiar content words from the learner's crosstalk session. */
  readonly vocabulary: ReadonlyArray<VocabularyItem>;
  /** How the native speaker talked, e.g. spoken forms. */
  readonly register: string;
  readonly topics: ReadonlyArray<string>;
  /** Recent curriculum sentences, newest first. */
  readonly recent: ReadonlyArray<RecentExample>;
  /**
   * Earlier sentences of the session for this target, newest first. They
   * and `recent` are never repeated: exact repeats are dropped before
   * review.
   */
  readonly earlier: ReadonlyArray<RecentExample>;
  /**
   * Content combinations (see {@link contentKey}) this sentence must not
   * reuse: required for transfer and review, which need fresh examples.
   */
  readonly avoidContent: ReadonlyArray<string>;
  /** Drafts to write; the author returns those that pass review, best first. */
  readonly candidates: number;
}

/** A reviewed curriculum sentence. */
export interface CurriculumDraft {
  readonly english: string;
  readonly finnish: string;
  /** Lemmas of the content words used (nouns, verbs, adjectives). */
  readonly contentWords: ReadonlyArray<string>;
  /** Which of the target's realisations was used, as its form text. */
  readonly realisation: string;
  /** The reviewer's remarks, kept for auditing. */
  readonly reviewNote: string;
}

/**
 * Identifies a combination of content words, so fresh examples can be told
 * from reworded ones regardless of word order or case.
 */
export const contentKey = (contentWords: ReadonlyArray<string>): string =>
  [...new Set(contentWords.map((word) => word.trim().toLowerCase()))]
    .filter((word) => word !== "")
    .toSorted()
    .join("+");

/** A draft that did not pass, and why; stored with the plan for auditing. */
export interface RejectedDraft {
  readonly finnish: string;
  readonly reason: string;
}

export interface CurriculumWriting {
  /** Drafts that passed every check, best first. */
  readonly accepted: ReadonlyArray<CurriculumDraft>;
  readonly rejected: ReadonlyArray<RejectedDraft>;
}

/**
 * Writes and independently reviews curriculum sentences. Only drafts that
 * isolate the target, use nothing beyond the allowed constructions and
 * familiar vocabulary, and are natural, standalone Finnish with an accurate
 * translation leave this service.
 */
export class CurriculumAuthor extends Context.Service<
  CurriculumAuthor,
  {
    readonly write: (
      brief: CurriculumBrief,
    ) => Effect.Effect<CurriculumWriting, AuthoringError>;
  }
>()("crosstalk-practice/curriculum/CurriculumAuthor") {}

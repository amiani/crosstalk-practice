import type {
  BackgroundGrammar,
  Catalog,
  LearningTarget,
  TargetId,
} from "./Catalog.ts";

/**
 * The curriculum's learner model and scheduler, as pure functions: evidence
 * from responses becomes a comprehension estimate per learning target, and
 * the estimates choose what the next sentence should teach. Nothing here
 * calls a model or a database, so every decision replays from its inputs.
 */

/** Why a sentence was chosen. None of this is ever shown to the learner. */
export type SentenceRole = "teaching" | "transfer" | "review";

/** A curriculum sentence the learner responded to, with what was observed. */
export interface Observation {
  /** Distinguishes content combinations, e.g. the familiar words used. */
  readonly contentKey: string;
  /** Structurally similar examples share a family. */
  readonly family: string;
  /** 0-based index among curriculum responses, in server order. */
  readonly order: number;
  /** Position of the sentence in the curriculum stream when it was served. */
  readonly position: number;
  /** Epoch milliseconds of the response. */
  readonly respondedAt: number;
  readonly role: SentenceRole;
  readonly sentenceId: string;
  /** Audio playbacks actually started across all presentations; null if unknown. */
  readonly startedPlaybacks: number | null;
  readonly targetId: TargetId;
  readonly targetRevision: number;
  /** Whether events through the response arrived without gaps. */
  readonly traceComplete: boolean;
  readonly translationRevealed: boolean;
  readonly understood: boolean;
  /**
   * False when the learner could not have listened properly (audio failed,
   * page hidden, responded before playback); null when not yet known.
   */
  readonly usable: boolean | null;
}

/**
 * - clean: understood from the audio alone, on one listen.
 * - replayed: understood from the audio alone after replaying.
 * - supported: understood only after revealing the translation.
 * - failure: not understood after a usable listen.
 * - unverified: understood, but the trace is incomplete, so unaided use is unknown.
 * - ambiguous: the presentation was not a fair listen.
 */
export type ObservationKind =
  | "clean"
  | "replayed"
  | "supported"
  | "failure"
  | "unverified"
  | "ambiguous";

export const classifyObservation = (
  observation: Observation,
): ObservationKind => {
  if (observation.usable === false) {
    return "ambiguous";
  }
  if (!observation.understood) {
    return "failure";
  }
  if (observation.translationRevealed) {
    return "supported";
  }
  if (!observation.traceComplete || observation.startedPlaybacks === null) {
    return "unverified";
  }
  return observation.startedPlaybacks > 1 ? "replayed" : "clean";
};

const isIndependentSuccess = (kind: ObservationKind) =>
  kind === "clean" || kind === "replayed";
const isInformative = (kind: ObservationKind) =>
  isIndependentSuccess(kind) || kind === "failure";

/**
 * - unintroduced: never practised.
 * - learning: being taught; not yet usable as supporting material.
 * - established: understood well enough to support other targets.
 *   Reversible, and never a claim of mastery.
 * - revisit: was established, but recent reviews went badly.
 */
export type TargetStatus =
  | "unintroduced"
  | "learning"
  | "established"
  | "revisit";

export interface TargetEstimate {
  readonly distinctContent: number;
  readonly establishedAtOrder: number | null;
  readonly exposures: number;
  readonly failures: number;
  readonly independentSuccesses: number;
  readonly informative: number;
  readonly lastPractisedAt: number | null;
  readonly lastPractisedOrder: number | null;
  /** Reviews answered since the target was last established. */
  readonly reviewsSinceEstablished: number;
  /** Transfer successes that count toward promotion (see `separatedCount`). */
  readonly separatedTransferSuccesses: number;
  /** The last two informative observations were both failures. */
  readonly struggling: boolean;
  /** Smoothed, decayed share of independent success; a heuristic, not a probability. */
  readonly support: number;
  readonly status: TargetStatus;
  readonly targetId: TargetId;
  /** Transfer sentences of this target answered, whatever the outcome. */
  readonly transferExposures: number;
  /**
   * Every promotion gate but the transfer checks is met: the learner model
   * is waiting on transfer sentences to promote the target.
   */
  readonly awaitingTransferCheck: boolean;
  /** Standard deviation of the smoothed support; large means little evidence. */
  readonly uncertainty: number;
}

export interface ModelPolicy {
  /** Evidence halves in weight after this long, relaxing toward the prior. */
  readonly halfLifeMs: number;
  /** Maximum positive weight from one family on one (UTC) day. */
  readonly maxFamilyDayWeight: number;
  readonly promotion: {
    readonly minDistinctContent: number;
    readonly minIndependentSuccesses: number;
    readonly minInformative: number;
    readonly minSeparatedTransferSuccesses: number;
    /** No failures among this many latest informative observations. */
    readonly recentWithoutFailure: number;
  };
  readonly version: string;
  readonly weights: {
    readonly failure: number;
    /** Multiplier for replay-supported success. */
    readonly replayed: number;
    readonly review: number;
    readonly teaching: number;
    readonly transfer: number;
  };
}

export const modelPolicyV1: ModelPolicy = {
  halfLifeMs: 30 * 24 * 60 * 60 * 1000,
  maxFamilyDayWeight: 1,
  promotion: {
    minDistinctContent: 3,
    minIndependentSuccesses: 6,
    minInformative: 8,
    minSeparatedTransferSuccesses: 2,
    recentWithoutFailure: 3,
  },
  version: "curriculum-model-v1",
  weights: { failure: 1, replayed: 0.5, review: 1, teaching: 0.5, transfer: 1 },
};

const dayOf = (epochMs: number) => Math.floor(epochMs / (24 * 60 * 60 * 1000));

interface Tally {
  contents: Set<string>;
  establishedAtOrder: number | null;
  exposures: number;
  failures: number;
  familyDay: Map<string, number>;
  independentSuccesses: number;
  informativeOutcomes: Array<boolean>;
  lastPractisedAt: number | null;
  lastPractisedOrder: number | null;
  reviewOutcomes: Array<boolean>;
  reviewsSinceEstablished: number;
  status: TargetStatus;
  transferExposures: number;
  transferSuccessPositions: Array<number>;
  weightedFailure: number;
  weightedSuccess: number;
}

const newTally = (): Tally => ({
  contents: new Set(),
  establishedAtOrder: null,
  exposures: 0,
  failures: 0,
  familyDay: new Map(),
  independentSuccesses: 0,
  informativeOutcomes: [],
  lastPractisedAt: null,
  lastPractisedOrder: null,
  reviewOutcomes: [],
  reviewsSinceEstablished: 0,
  status: "unintroduced",
  transferExposures: 0,
  transferSuccessPositions: [],
  weightedFailure: 0,
  weightedSuccess: 0,
});

/** Transfer successes at least one sentence apart, counted greedily. */
const separatedCount = (positions: ReadonlyArray<number>) => {
  let count = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const position of [...positions].toSorted((a, b) => a - b)) {
    if (position - last > 1) {
      count += 1;
      last = position;
    }
  }
  return count;
};

/** Every promotion gate except the transfer checks. */
const readyForTransferCheck = (tally: Tally, policy: ModelPolicy) => {
  const gates = policy.promotion;
  const recent = tally.informativeOutcomes.slice(-gates.recentWithoutFailure);
  return (
    tally.informativeOutcomes.length >= gates.minInformative &&
    tally.independentSuccesses >= gates.minIndependentSuccesses &&
    tally.contents.size >= gates.minDistinctContent &&
    recent.length === gates.recentWithoutFailure &&
    recent.every(Boolean)
  );
};

const meetsPromotion = (tally: Tally, policy: ModelPolicy) =>
  readyForTransferCheck(tally, policy) &&
  separatedCount(tally.transferSuccessPositions) >=
    policy.promotion.minSeparatedTransferSuccesses;

/** Re-establishing needs a clean recent run including a fresh example. */
const meetsRecovery = (
  tally: Tally,
  recentRoles: ReadonlyArray<SentenceRole>,
) => {
  const recent = tally.informativeOutcomes.slice(-3);
  return (
    recent.length === 3 &&
    recent.every(Boolean) &&
    recentRoles.slice(-3).some((role) => role !== "teaching")
  );
};

/**
 * Folds responses into one estimate per target in the catalog. Observations
 * are applied in response order; a sentence counts at most once, and
 * evidence for another revision of a target is ignored.
 */
export const estimateTargets = (
  catalog: Catalog,
  observations: ReadonlyArray<Observation>,
  now: number,
  policy: ModelPolicy = modelPolicyV1,
): ReadonlyMap<TargetId, TargetEstimate> => {
  const revisions = new Map(
    catalog.targets.map((target) => [target.id, target.revision]),
  );
  const tallies = new Map(
    catalog.targets.map((target) => [target.id, newTally()]),
  );
  const informativeRoles = new Map<TargetId, Array<SentenceRole>>();
  const seen = new Set<string>();
  const ordered = [...observations].toSorted((a, b) => a.order - b.order);
  for (const observation of ordered) {
    const tally = tallies.get(observation.targetId);
    if (
      tally === undefined ||
      revisions.get(observation.targetId) !== observation.targetRevision ||
      seen.has(observation.sentenceId)
    ) {
      continue;
    }
    seen.add(observation.sentenceId);
    const kind = classifyObservation(observation);
    tally.exposures += 1;
    if (observation.role === "transfer") {
      tally.transferExposures += 1;
    }
    tally.lastPractisedAt = observation.respondedAt;
    tally.lastPractisedOrder = observation.order;
    if (tally.status === "unintroduced") {
      tally.status = "learning";
    }
    if (!isInformative(kind)) {
      continue;
    }
    const success = isIndependentSuccess(kind);
    const decay =
      0.5 ** (Math.max(0, now - observation.respondedAt) / policy.halfLifeMs);
    if (success) {
      tally.independentSuccesses += 1;
      tally.contents.add(observation.contentKey);
      if (observation.role === "transfer") {
        tally.transferSuccessPositions.push(observation.position);
      }
      const roleWeight = policy.weights[observation.role];
      const raw =
        kind === "replayed" ? roleWeight * policy.weights.replayed : roleWeight;
      const key = `${observation.family}|${dayOf(observation.respondedAt)}`;
      const used = tally.familyDay.get(key) ?? 0;
      const granted = Math.max(
        0,
        Math.min(raw, policy.maxFamilyDayWeight - used),
      );
      tally.familyDay.set(key, used + granted);
      tally.weightedSuccess += granted * decay;
    } else {
      tally.failures += 1;
      tally.weightedFailure += policy.weights.failure * decay;
    }
    tally.informativeOutcomes.push(success);
    const roles = informativeRoles.get(observation.targetId) ?? [];
    roles.push(observation.role);
    informativeRoles.set(observation.targetId, roles);

    if (tally.status === "established") {
      if (observation.role === "review") {
        tally.reviewsSinceEstablished += 1;
        tally.reviewOutcomes.push(success);
        const latest = tally.reviewOutcomes.slice(-3);
        if (latest.filter((outcome) => !outcome).length >= 2) {
          tally.status = "revisit";
          tally.reviewOutcomes = [];
        }
      }
    } else if (
      (tally.status === "learning" && meetsPromotion(tally, policy)) ||
      (tally.status === "revisit" && meetsRecovery(tally, roles))
    ) {
      tally.status = "established";
      tally.establishedAtOrder = observation.order;
      tally.reviewsSinceEstablished = 0;
      tally.reviewOutcomes = [];
    }
  }
  const estimates = new Map<TargetId, TargetEstimate>();
  for (const [targetId, tally] of tallies) {
    const alpha = 1 + tally.weightedSuccess;
    const beta = 1 + tally.weightedFailure;
    const total = alpha + beta;
    const lastTwo = tally.informativeOutcomes.slice(-2);
    estimates.set(targetId, {
      awaitingTransferCheck:
        tally.status === "learning" && readyForTransferCheck(tally, policy),
      distinctContent: tally.contents.size,
      establishedAtOrder: tally.establishedAtOrder,
      exposures: tally.exposures,
      failures: tally.failures,
      independentSuccesses: tally.independentSuccesses,
      informative: tally.informativeOutcomes.length,
      lastPractisedAt: tally.lastPractisedAt,
      lastPractisedOrder: tally.lastPractisedOrder,
      reviewsSinceEstablished: tally.reviewsSinceEstablished,
      separatedTransferSuccesses: separatedCount(
        tally.transferSuccessPositions,
      ),
      status: tally.status,
      struggling: lastTwo.length === 2 && lastTwo.every((outcome) => !outcome),
      support: alpha / total,
      targetId,
      transferExposures: tally.transferExposures,
      uncertainty: Math.sqrt((alpha * beta) / (total * total * (total + 1))),
    });
  }
  return estimates;
};

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

/** A sentence already served in the curriculum stream, answered or not. */
export interface Selection {
  readonly role: SentenceRole;
  readonly targetId: TargetId;
  /** False while the sentence awaits an answer; unknown counts as answered. */
  readonly answered?: boolean;
}

export interface SelectionPolicy {
  readonly maxActiveTargets: number;
  /** A target is never chosen more than this many times in a row if avoidable. */
  readonly maxConsecutive: number;
  /** An active target waiting this many sentences is chosen next. */
  readonly maxWait: number;
  /** Answered curriculum sentences before the first review of a new target. */
  readonly firstReviewAfterAnswers: number;
  /** Elapsed time before each later review; the last interval repeats. */
  readonly reviewIntervalsMs: ReadonlyArray<number>;
  /** Share of each role over the rolling window. */
  readonly roleMix: Readonly<Record<SentenceRole, number>>;
  /**
   * Exposures after which an active, non-struggling target may support
   * other targets' sentences, before it is established. Mixing introduced
   * targets gives the writer enough material to avoid repeating itself.
   */
  readonly supportAfterExposures: number;
  /** Exposures to a target before transfer sentences are attempted. */
  readonly transferAfterExposures: number;
  /** Other sentences between the target's last selection and its transfer. */
  readonly transferSeparation: number;
  readonly version: string;
  readonly window: number;
}

const day = 24 * 60 * 60 * 1000;

export const selectionPolicyV1: SelectionPolicy = {
  firstReviewAfterAnswers: 10,
  maxActiveTargets: 4,
  maxConsecutive: 2,
  maxWait: 5,
  reviewIntervalsMs: [day, 3 * day, 7 * day, 14 * day],
  roleMix: { review: 0.2, teaching: 0.6, transfer: 0.2 },
  supportAfterExposures: 3,
  transferAfterExposures: 3,
  transferSeparation: 1,
  version: "curriculum-selection-v4",
  window: 10,
};

export interface SentencePlan {
  /** The targets currently receiving focused practice. */
  readonly activeSet: ReadonlyArray<TargetId>;
  /** Unassessed grammar the sentence may use, from established targets. */
  readonly backgroundGrammar: ReadonlyArray<string>;
  /** Simplify the example: the learner is struggling with this target. */
  readonly easier: boolean;
  /** Human-readable account of the decision, stored for auditing. */
  readonly reason: string;
  readonly role: SentenceRole;
  /**
   * Targets the sentence may use as supporting material: established ones,
   * and introduced active ones the learner is not struggling with.
   */
  readonly supportingTargets: ReadonlyArray<TargetId>;
  readonly targetId: TargetId;
  readonly targetRevision: number;
}

export interface SelectionInput {
  readonly catalog: Catalog;
  readonly estimates: ReadonlyMap<TargetId, TargetEstimate>;
  /** Served curriculum sentences, oldest first. */
  readonly history: ReadonlyArray<Selection>;
  readonly now: number;
  /** How many curriculum sentences have been answered in total. */
  readonly answeredCount: number;
  /**
   * Targets whose latest attempt to write a sentence failed recently; they
   * are passed over while anything else can be chosen.
   */
  readonly cooling?: ReadonlySet<TargetId>;
}

const statusOf = (input: SelectionInput, id: TargetId): TargetStatus =>
  input.estimates.get(id)?.status ?? "unintroduced";

const isEligible = (input: SelectionInput, target: LearningTarget) =>
  target.prerequisites.every((id) => statusOf(input, id) === "established");

/** Background grammar whose required targets are all established. */
export const availableBackground = (
  catalog: Catalog,
  estimates: ReadonlyMap<TargetId, TargetEstimate>,
): ReadonlyArray<BackgroundGrammar> =>
  catalog.background.filter((grammar) =>
    grammar.requires.every((id) => estimates.get(id)?.status === "established"),
  );

/**
 * The learning targets to focus on now, in priority order: those being
 * learned or revisited, then eligible new targets in catalog order.
 */
export const activeTargets = (
  input: SelectionInput,
  policy: SelectionPolicy = selectionPolicyV1,
): ReadonlyArray<LearningTarget> => {
  const eligible = input.catalog.targets.filter(
    (target) =>
      statusOf(input, target.id) !== "established" && isEligible(input, target),
  );
  const priority: Readonly<Record<TargetStatus, number>> = {
    established: 3,
    learning: 1,
    revisit: 0,
    unintroduced: 2,
  };
  const rank = (target: LearningTarget) => priority[statusOf(input, target.id)];
  return eligible
    .map((target, index) => ({ index, target }))
    .toSorted((a, b) => rank(a.target) - rank(b.target) || a.index - b.index)
    .slice(0, policy.maxActiveTargets)
    .map(({ target }) => target);
};

const answersSince = (input: SelectionInput, estimate: TargetEstimate) =>
  input.answeredCount - 1 - (estimate.lastPractisedOrder ?? -1);

/** Established targets due another look, most overdue first. */
export const dueReviews = (
  input: SelectionInput,
  policy: SelectionPolicy = selectionPolicyV1,
): ReadonlyArray<LearningTarget> => {
  const overdue = (target: LearningTarget): number | undefined => {
    const estimate = input.estimates.get(target.id);
    if (
      estimate?.status !== "established" ||
      estimate.lastPractisedAt === null
    ) {
      return undefined;
    }
    if (estimate.reviewsSinceEstablished === 0) {
      const since = answersSince(input, estimate);
      return since >= policy.firstReviewAfterAnswers
        ? since - policy.firstReviewAfterAnswers
        : undefined;
    }
    const intervals = policy.reviewIntervalsMs;
    const interval =
      intervals[
        Math.min(estimate.reviewsSinceEstablished - 1, intervals.length - 1)
      ] ?? day;
    const elapsed = input.now - estimate.lastPractisedAt;
    return elapsed >= interval ? (elapsed - interval) / interval : undefined;
  };
  return input.catalog.targets
    .map((target) => ({ overdue: overdue(target), target }))
    .filter(
      (entry): entry is { overdue: number; target: LearningTarget } =>
        entry.overdue !== undefined,
    )
    .toSorted((a, b) => b.overdue - a.overdue)
    .map(({ target }) => target);
};

/** Selections since the target was last served; Infinity if never. */
const staleness = (history: ReadonlyArray<Selection>, id: TargetId) => {
  const index = history.findLastIndex((selection) => selection.targetId === id);
  return index === -1 ? Number.POSITIVE_INFINITY : history.length - 1 - index;
};

/** Candidates that would not extend a run of the same target too far. */
const avoidLongRuns = (
  candidates: ReadonlyArray<LearningTarget>,
  history: ReadonlyArray<Selection>,
  policy: SelectionPolicy,
) => {
  const tail = history.slice(-policy.maxConsecutive);
  const [first] = tail;
  const repeated =
    first !== undefined &&
    tail.length === policy.maxConsecutive &&
    tail.every((selection) => selection.targetId === first.targetId)
      ? first.targetId
      : undefined;
  const allowed = candidates.filter((target) => target.id !== repeated);
  return allowed.length > 0 ? allowed : candidates;
};

const describeChoice = (
  input: SelectionInput,
  target: LearningTarget,
  role: SentenceRole,
): string => {
  if (role === "transfer") {
    return "Fresh example to check the target beyond recent sentences";
  }
  if (role === "review") {
    return "Established target due for review";
  }
  return statusOf(input, target.id) === "unintroduced"
    ? "Introducing a newly eligible target"
    : "Focused practice of an active target";
};

/**
 * Chooses the next sentence: which target, in which role, and how simply.
 * Deterministic for the same inputs. Returns undefined only when the
 * catalog offers nothing that can be taught or reviewed.
 */
export const selectNext = (
  input: SelectionInput,
  policy: SelectionPolicy = selectionPolicyV1,
): SentencePlan | undefined => {
  const cooling = input.cooling ?? new Set<TargetId>();
  const warm = (targets: ReadonlyArray<LearningTarget>) => {
    const ready = targets.filter((target) => !cooling.has(target.id));
    return ready.length > 0 ? ready : targets;
  };
  const allActive = activeTargets(input, policy);
  const active = warm(allActive);
  const reviews = warm(dueReviews(input, policy));
  const established = input.catalog.targets.filter(
    (target) => statusOf(input, target.id) === "established",
  );
  const introduced = allActive.filter((target) => {
    const estimate = input.estimates.get(target.id);
    return (
      estimate?.status === "learning" &&
      !estimate.struggling &&
      estimate.exposures >= policy.supportAfterExposures
    );
  });
  const supportingTargets = [...established, ...introduced].map(
    (target) => target.id,
  );
  const activeSet = allActive.map((target) => target.id);
  const backgroundGrammar = availableBackground(
    input.catalog,
    input.estimates,
  ).map((grammar) => grammar.id);
  const plan = (
    target: LearningTarget,
    role: SentenceRole,
    reason: string,
  ): SentencePlan => {
    const easier = input.estimates.get(target.id)?.struggling === true;
    return {
      activeSet,
      backgroundGrammar,
      easier,
      reason: easier ? `${reason}; recent failures, so simplify` : reason,
      role,
      supportingTargets: supportingTargets.filter((id) => id !== target.id),
      targetId: target.id,
      targetRevision: target.revision,
    };
  };

  const transferable = active.filter((target) => {
    const estimate = input.estimates.get(target.id);
    return (
      estimate !== undefined &&
      !estimate.struggling &&
      estimate.exposures >= policy.transferAfterExposures &&
      staleness(input.history, target.id) >= policy.transferSeparation
    );
  });
  // A target that has passed every other promotion gate is checked with a
  // transfer sentence as soon as possible, one outstanding at a time, so
  // the role mix never holds back its promotion.
  const checkDue = avoidLongRuns(
    transferable.filter(
      (target) =>
        input.estimates.get(target.id)?.awaitingTransferCheck === true &&
        !input.history.some(
          (selection) =>
            selection.targetId === target.id &&
            selection.role === "transfer" &&
            selection.answered === false,
        ),
    ),
    input.history,
    policy,
  )[0];
  const window = input.history.slice(-(policy.window - 1));
  const deficit = (role: SentenceRole) =>
    policy.roleMix[role] * policy.window -
    window.filter((selection) => selection.role === role).length;
  const available: Readonly<Record<SentenceRole, boolean>> = {
    review: reviews.length > 0,
    teaching: active.length > 0,
    transfer: transferable.length > 0,
  };
  const roles = (["review", "transfer", "teaching"] as const).filter(
    (candidate) => available[candidate],
  );
  const role = roles.toSorted((a, b) => deficit(b) - deficit(a))[0];

  if (checkDue !== undefined && role !== "review") {
    return plan(
      checkDue,
      "transfer",
      "Transfer check: every other promotion gate is met",
    );
  }
  const waiting = avoidLongRuns(
    active.filter(
      (target) => staleness(input.history, target.id) >= policy.maxWait,
    ),
    input.history,
    policy,
  )[0];
  if (waiting !== undefined && role !== "review") {
    const waitingRole =
      role === "transfer" && transferable.includes(waiting)
        ? "transfer"
        : "teaching";
    return plan(
      waiting,
      waitingRole,
      `${describeChoice(input, waiting, waitingRole)}; it has waited longest`,
    );
  }
  if (role === "review") {
    const target = avoidLongRuns(reviews, input.history, policy)[0];
    return (
      target && plan(target, "review", "Established target due for review")
    );
  }
  if (role !== undefined) {
    const pool = role === "transfer" ? transferable : active;
    const score = (target: LearningTarget) =>
      Math.min(staleness(input.history, target.id), 1_000) +
      (input.estimates.get(target.id)?.struggling === true ? 1 : 0);
    const target = avoidLongRuns(pool, input.history, policy)
      .map((candidate, index) => ({ candidate, index }))
      .toSorted(
        (a, b) => score(b.candidate) - score(a.candidate) || a.index - b.index,
      )[0]?.candidate;
    return target && plan(target, role, describeChoice(input, target, role));
  }
  const consolidate = established
    .map((target, index) => ({ index, target }))
    .toSorted(
      (a, b) =>
        (input.estimates.get(a.target.id)?.lastPractisedOrder ?? -1) -
          (input.estimates.get(b.target.id)?.lastPractisedOrder ?? -1) ||
        a.index - b.index,
    )[0]?.target;
  return (
    consolidate &&
    plan(consolidate, "review", "Nothing new is eligible; consolidating")
  );
};

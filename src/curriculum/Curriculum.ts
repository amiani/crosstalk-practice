import {
  Clock,
  Context,
  Effect,
  FiberSet,
  Layer,
  Ref,
  Result,
  Semaphore,
} from "effect";

import { audioPath } from "../api/Api.ts";
import type {
  PracticeItem,
  SessionId,
  SessionProfile,
} from "../domain/model.ts";
import { normalizeSentence } from "../practice/normalize.ts";
import { PracticeSettings } from "../practice/PracticeSettings.ts";
import { PracticeStore } from "../practice/PracticeStore.ts";
import type { PracticeStoreError } from "../practice/PracticeStore.ts";
import { SpeechSynthesizer } from "../speech/SpeechSynthesizer.ts";
import type { Catalog, LearningTarget } from "./Catalog.ts";
import { pilotCatalog } from "./catalog/pilot.ts";
import {
  CURRICULUM_AUTHOR_VERSION,
  CurriculumAuthor,
  contentKey,
} from "./CurriculumAuthor.ts";
import type { CurriculumBrief, RejectedDraft } from "./CurriculumAuthor.ts";
import {
  estimateTargets,
  modelPolicyV1,
  selectNext,
  selectionPolicyV1,
} from "./CurriculumPolicy.ts";
import type { SentencePlan, TargetEstimate } from "./CurriculumPolicy.ts";
import { CurriculumStore } from "./CurriculumStore.ts";
import type {
  CurriculumSentenceAwaitingAudio,
  NewPlan,
  PlanOutcome,
  PlannedSelection,
} from "./CurriculumStore.ts";

/**
 * Consecutive jobs that produce no sentence before finishing jobs stop
 * starting new ones; the next wake-up tries again.
 */
const MAX_UNPRODUCTIVE_PLANS = 3;
/** Drafts requested per plan. */
const CANDIDATES_PER_PLAN = 4;
/**
 * Teaching sentences kept from one writing: the extras get plans of their
 * own, so one paid round can fill more of the buffer.
 */
const TEACHING_SENTENCES_PER_WRITING = 2;
/** Teaching sentences of a target that share a family. */
const TEACHING_FAMILY_SIZE = 4;
const RECENT_EXAMPLES = 12;
/** Earlier sentences of the same target shown to the writer. */
const TARGET_EXAMPLES = 60;
/**
 * A target whose latest plan failed within this many latest plans is
 * passed over, so an exhausted target does not stall the buffer.
 */
const COOLDOWN_PLANS = 4;
const MAX_VOCABULARY = 60;

/** Targets whose latest plan among the recent ones failed. */
export const coolingTargets = (
  recent: ReadonlyArray<PlanOutcome>,
): ReadonlySet<string> => {
  const latest = new Map<string, PlanOutcome["status"]>();
  for (const outcome of recent) {
    if (!latest.has(outcome.targetId)) {
      latest.set(outcome.targetId, outcome.status);
    }
  }
  return new Set(
    [...latest]
      .filter(([, status]) => status === "failed")
      .map(([targetId]) => targetId),
  );
};

/**
 * Teaching sentences come in small families of deliberately similar
 * examples; every transfer or review sentence is its own family.
 */
export const familyFor = (
  plan: SentencePlan,
  history: ReadonlyArray<PlannedSelection>,
  now: number,
): string => {
  if (plan.role !== "teaching") {
    return `${plan.targetId}:${plan.role}:${now}`;
  }
  const taught = history.filter(
    (selection) =>
      selection.targetId === plan.targetId && selection.role === "teaching",
  ).length;
  return `${plan.targetId}:teaching:${Math.floor(taught / TEACHING_FAMILY_SIZE)}`;
};

const eligible = (
  estimates: ReadonlyMap<string, TargetEstimate>,
  target: LearningTarget,
) =>
  target.prerequisites.every(
    (id) => estimates.get(id)?.status === "established",
  );

/**
 * Curriculum practice for the active session: choosing, writing and voicing
 * the next sentences, and choosing which of them to serve.
 */
export class Curriculum extends Context.Service<
  Curriculum,
  {
    /**
     * Starts as many writing jobs as the buffer of curriculum sentences
     * lacks, counting jobs already under way and up to the concurrency
     * limit, and returns without waiting for them. Each finished job checks
     * again, so the buffer refills continuously. `stillCurrent` is checked
     * before every plan so a switch or reset stops the work promptly.
     */
    readonly replenish: (
      sessionId: SessionId,
      profile: SessionProfile,
      stillCurrent: Effect.Effect<boolean, PracticeStoreError>,
    ) => Effect.Effect<void, PracticeStoreError>;
    /** Waits until no writing jobs are running (they may start one another). */
    readonly idle: Effect.Effect<void>;
    /**
     * Brings evidence and plans up to date after a restart or late events;
     * pending plans are abandoned only when no job of the session runs.
     */
    readonly reconcile: (
      sessionId: SessionId,
    ) => Effect.Effect<void, PracticeStoreError>;
    /** Voiced sentences still worth teaching, in the order to hear them. */
    readonly upcoming: (
      sessionId: SessionId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PracticeItem>, PracticeStoreError>;
    readonly catalog: Catalog;
  }
>()("crosstalk-practice/curriculum/Curriculum") {
  public static readonly layerWith = (catalog: Catalog) =>
    Layer.effect(
      Curriculum,
      Effect.gen(function* () {
        const store = yield* CurriculumStore;
        const practice = yield* PracticeStore;
        const author = yield* CurriculumAuthor;
        const synthesizer = yield* SpeechSynthesizer;
        const settings = yield* PracticeSettings;
        const byId = new Map(
          catalog.targets.map((target) => [target.id, target]),
        );
        const backgroundById = new Map(
          catalog.background.map((grammar) => [grammar.id, grammar]),
        );

        const currentEstimates = Effect.gen(function* () {
          const observations = yield* store.observations;
          const now = yield* Clock.currentTimeMillis;
          return {
            estimates: estimateTargets(catalog, observations, now),
            now,
            observations,
          };
        });

        /**
         * Chooses the next sentence and stores its plan. Plans are made one
         * at a time (see `replenish`), so each sees every plan before it.
         */
        const planOne = Effect.fn("Curriculum.planOne")(function* (
          sessionId: SessionId,
          profile: SessionProfile,
        ) {
          const { estimates, now, observations } = yield* currentEstimates;
          const history = yield* store.history(sessionId);
          const cooling = coolingTargets(
            yield* store.recentPlans(sessionId, COOLDOWN_PLANS),
          );
          const plan = selectNext(
            {
              answeredCount: observations.length,
              catalog,
              cooling,
              estimates,
              history,
              now,
            },
            selectionPolicyV1,
          );
          if (plan === undefined) {
            yield* Effect.logWarning(
              "The curriculum has nothing to teach or review",
            );
            return undefined;
          }
          const target = byId.get(plan.targetId);
          if (target === undefined) {
            return yield* Effect.die(
              `Unknown curriculum target ${plan.targetId}`,
            );
          }
          const newPlan: NewPlan = {
            authorVersion: CURRICULUM_AUTHOR_VERSION,
            catalogVersion: catalog.version,
            decision: {
              activeSet: plan.activeSet,
              answeredCount: observations.length,
              backgroundGrammar: plan.backgroundGrammar,
              cooling: [...cooling],
              estimate: estimates.get(plan.targetId) ?? null,
              supportingTargets: plan.supportingTargets,
            },
            family: familyFor(plan, history, now),
            modelVersion: modelPolicyV1.version,
            plan,
            selectionVersion: selectionPolicyV1.version,
          };
          const created = yield* store.createPlan(sessionId, newPlan);
          if (created._tag === "None") {
            return undefined;
          }
          const brief: CurriculumBrief = {
            avoidContent:
              plan.role === "teaching"
                ? []
                : yield* store.usedContent(plan.targetId),
            background: plan.backgroundGrammar.flatMap((id) => {
              const grammar = backgroundById.get(id);
              return grammar === undefined ? [] : [grammar];
            }),
            candidates: CANDIDATES_PER_PLAN,
            earlier: yield* store.targetExamples(
              sessionId,
              plan.targetId,
              TARGET_EXAMPLES,
            ),
            plan,
            recent: yield* store.recentExamples(sessionId, RECENT_EXAMPLES),
            register: profile.register,
            supporting: plan.supportingTargets.flatMap((id) => {
              const supporting = byId.get(id);
              return supporting === undefined ? [] : [supporting];
            }),
            target,
            topics: profile.topics,
            vocabulary: profile.vocabulary.slice(0, MAX_VOCABULARY),
          };
          return { brief, newPlan, planId: created.value.planId };
        });

        const voice = (sentence: CurriculumSentenceAwaitingAudio) =>
          synthesizer.synthesize(sentence.finnish).pipe(
            Effect.flatMap((speech) =>
              practice.saveAudio(sentence.sentenceId, speech),
            ),
            // Left without audio, the sentence is retried next pass.
            Effect.catchTag("SpeechSynthesisError", (error) =>
              Effect.logWarning("Speech synthesis failed", error),
            ),
          );

        /** Sentences being voiced, so none is voiced twice at once. */
        const voicing = yield* Ref.make<ReadonlySet<string>>(new Set());
        const voiceOnce = (sentence: CurriculumSentenceAwaitingAudio) =>
          Ref.modify(voicing, (ids): [boolean, ReadonlySet<string>] =>
            ids.has(sentence.sentenceId)
              ? [false, ids]
              : [true, new Set([...ids, sentence.sentenceId])],
          ).pipe(
            Effect.flatMap((claimed) =>
              claimed
                ? voice(sentence).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError(
                        "Voicing a curriculum sentence failed",
                        cause,
                      ),
                    ),
                    Effect.ensuring(
                      Ref.update(
                        voicing,
                        (ids) =>
                          new Set(
                            [...ids].filter((id) => id !== sentence.sentenceId),
                          ),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          );

        /**
         * Writes, stores and voices a planned sentence, plus extra teaching
         * sentences from the same writing while `extra` grants plans (and
         * buffer slots) for them; false if none was stored. `onStored` runs
         * once the plan's own sentence is stored.
         */
        const realise = Effect.fn("Curriculum.realise")(function* (work: {
          readonly brief: CurriculumBrief;
          readonly newPlan: NewPlan;
          readonly planId: string;
          readonly onStored: Effect.Effect<void>;
          readonly extra: (plan: NewPlan) => Effect.Effect<
            | {
                readonly planId: string;
                readonly release: Effect.Effect<void>;
              }
            | undefined,
            PracticeStoreError
          >;
        }) {
          const { brief, extra, onStored, planId } = work;
          const writing = yield* author.write(brief).pipe(Effect.result);
          if (Result.isFailure(writing)) {
            yield* Effect.logError(
              "Curriculum sentence generation failed",
              writing.failure,
            );
            yield* store.failPlan(planId, [
              {
                finnish: "",
                reason: `generation failed: ${writing.failure.message}`,
              },
            ]);
            return false;
          }
          const rejections: Array<RejectedDraft> = [
            ...writing.success.rejected,
          ];
          const keep =
            brief.plan.role === "teaching" ? TEACHING_SENTENCES_PER_WRITING : 1;
          let stored = 0;
          for (const draft of writing.success.accepted) {
            if (stored >= keep) {
              break;
            }
            const normalized = normalizeSentence(draft.finnish);
            if (normalized === "") {
              continue;
            }
            const claim =
              stored === 0
                ? { planId, release: onStored }
                : yield* extra({
                    ...work.newPlan,
                    plan: {
                      ...brief.plan,
                      reason: `${brief.plan.reason}; another sentence from the same writing`,
                    },
                  });
            if (claim === undefined) {
              break;
            }
            const target = claim.planId;
            const written = yield* store.writeSentence(target, {
              contentKey: contentKey(draft.contentWords),
              english: draft.english,
              finnish: draft.finnish,
              normalized,
              realisation: draft.realisation,
              rejections: stored === 0 ? rejections : [],
              reviewNote: draft.reviewNote,
            });
            if (written._tag === "Some" || stored > 0) {
              // The sentence now counts as unanswered, or the extra plan is
              // settled: either way its slot is no longer a reservation.
              yield* claim.release;
            }
            if (written._tag === "Some") {
              yield* Effect.logInfo("Generated curriculum sentence").pipe(
                Effect.annotateLogs({
                  easier: brief.plan.easier,
                  role: brief.plan.role,
                  target: brief.plan.targetId,
                }),
              );
              yield* voiceOnce({
                finnish: draft.finnish,
                sentenceId: written.value,
              });
              stored += 1;
              continue;
            }
            const duplicate = {
              finnish: draft.finnish,
              reason: "duplicate of an earlier sentence",
            };
            if (stored === 0) {
              rejections.push(duplicate);
            } else {
              yield* store.failPlan(target, [duplicate]);
            }
          }
          if (stored === 0) {
            yield* store.failPlan(planId, rejections);
          }
          return stored > 0;
        });

        interface Lane {
          /** Writing jobs under way. */
          readonly running: number;
          /** Buffer slots claimed by jobs whose sentence is not stored yet. */
          readonly reserved: number;
          /** Consecutive jobs that stored nothing. */
          readonly unproductive: number;
        }
        const emptyLane: Lane = { reserved: 0, running: 0, unproductive: 0 };

        /** Writing and voicing jobs, which outlive the call that starts them. */
        const jobs = yield* FiberSet.make<void, never>();
        /** Guards the lanes while jobs are started or slots claimed. */
        const scheduling = yield* Semaphore.make(1);
        /** Plans are chosen one at a time, so each sees the plans before it. */
        const planning = yield* Semaphore.make(1);
        const lanes = yield* Ref.make<ReadonlyMap<SessionId, Lane>>(new Map());

        const laneOf = (sessionId: SessionId) =>
          Ref.get(lanes).pipe(
            Effect.map((all) => all.get(sessionId) ?? emptyLane),
          );
        const updateLane = (sessionId: SessionId, f: (lane: Lane) => Lane) =>
          Ref.update(lanes, (all) => {
            const next = new Map(all);
            next.set(sessionId, f(all.get(sessionId) ?? emptyLane));
            return next;
          });
        const totalRunning = Ref.get(lanes).pipe(
          Effect.map((all) =>
            [...all.values()].reduce((sum, lane) => sum + lane.running, 0),
          ),
        );
        const releaseSlot = (sessionId: SessionId) =>
          updateLane(sessionId, (lane) => ({
            ...lane,
            reserved: lane.reserved - 1,
          }));
        /** Buffer slots neither filled nor claimed by a running job. */
        const missing = (sessionId: SessionId) =>
          Effect.gen(function* () {
            const unanswered = yield* store.unansweredCount(
              sessionId,
              catalog.version,
            );
            const lane = yield* laneOf(sessionId);
            return settings.curriculumBufferSize - unanswered - lane.reserved;
          });

        /** Claims a slot and a plan for another sentence from one writing. */
        const extra =
          (
            sessionId: SessionId,
            stillCurrent: Effect.Effect<boolean, PracticeStoreError>,
          ) =>
          (plan: NewPlan) =>
            scheduling.withPermits(1)(
              Effect.gen(function* () {
                if (
                  !(yield* stillCurrent) ||
                  (yield* missing(sessionId)) <= 0
                ) {
                  return undefined;
                }
                const created = yield* planning.withPermits(1)(
                  store.createPlan(sessionId, plan),
                );
                if (created._tag === "None") {
                  return undefined;
                }
                yield* updateLane(sessionId, (lane) => ({
                  ...lane,
                  reserved: lane.reserved + 1,
                }));
                return {
                  planId: created.value.planId,
                  release: releaseSlot(sessionId),
                };
              }),
            );

        /**
         * One writing job: plan, write, store and voice a sentence, holding
         * the buffer slot claimed for it until the sentence is stored. When
         * it ends it looks for more work, unless jobs keep producing nothing.
         */
        function job(
          sessionId: SessionId,
          profile: SessionProfile,
          stillCurrent: Effect.Effect<boolean, PracticeStoreError>,
        ): Effect.Effect<void> {
          return Effect.gen(function* () {
            const held = yield* Ref.make(true);
            const release = Ref.getAndSet(held, false).pipe(
              Effect.flatMap((holding) =>
                holding ? releaseSlot(sessionId) : Effect.void,
              ),
            );
            const produced = yield* Effect.gen(function* () {
              const work = yield* planning.withPermits(1)(
                Effect.gen(function* () {
                  if (!(yield* stillCurrent)) {
                    return undefined;
                  }
                  return yield* planOne(sessionId, profile);
                }),
              );
              if (work === undefined) {
                return false;
              }
              return yield* realise({
                ...work,
                extra: extra(sessionId, stillCurrent),
                onStored: release,
              });
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Curriculum writing job failed", cause).pipe(
                  Effect.as(false),
                ),
              ),
              Effect.ensuring(release),
              Effect.ensuring(
                updateLane(sessionId, (lane) => ({
                  ...lane,
                  running: lane.running - 1,
                })),
              ),
            );
            const lane = yield* laneOf(sessionId);
            const unproductive = produced ? 0 : lane.unproductive + 1;
            yield* updateLane(sessionId, (current) => ({
              ...current,
              unproductive,
            }));
            if (unproductive === MAX_UNPRODUCTIVE_PLANS) {
              yield* Effect.logWarning(
                "Curriculum generation produced no new sentences; will try again later",
              );
            }
            yield* schedule(sessionId, profile, stillCurrent).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Scheduling curriculum writing failed", cause),
              ),
            );
          });
        }

        /** Starts jobs for the buffer's missing sentences, up to the concurrency limit. */
        function schedule(
          sessionId: SessionId,
          profile: SessionProfile,
          stillCurrent: Effect.Effect<boolean, PracticeStoreError>,
        ): Effect.Effect<void, PracticeStoreError> {
          return scheduling.withPermits(1)(
            Effect.gen(function* () {
              if (!(yield* stillCurrent)) {
                return;
              }
              const lane = yield* laneOf(sessionId);
              if (lane.unproductive >= MAX_UNPRODUCTIVE_PLANS) {
                return;
              }
              const free =
                Math.max(1, settings.curriculumConcurrency) -
                (yield* totalRunning);
              const count = Math.min(yield* missing(sessionId), free);
              for (let started = 0; started < count; started += 1) {
                yield* updateLane(sessionId, (current) => ({
                  ...current,
                  reserved: current.reserved + 1,
                  running: current.running + 1,
                }));
                yield* FiberSet.run(
                  jobs,
                  job(sessionId, profile, stillCurrent),
                );
              }
            }),
          );
        }

        const replenish = Effect.fn("Curriculum.replenish")(function* (
          sessionId: SessionId,
          profile: SessionProfile,
          stillCurrent: Effect.Effect<boolean, PracticeStoreError>,
        ) {
          // Sentences whose voicing failed earlier are retried.
          for (const sentence of yield* store.awaitingAudio(sessionId)) {
            yield* FiberSet.run(jobs, voiceOnce(sentence));
          }
          // A wake-up from outside (an answer, a switch, the safety net) is
          // a fresh chance after jobs stopped producing.
          yield* updateLane(sessionId, (lane) => ({
            ...lane,
            unproductive: 0,
          }));
          yield* schedule(sessionId, profile, stillCurrent);
        });

        const reconcile = Effect.fn("Curriculum.reconcile")(function* (
          sessionId: SessionId,
        ) {
          // Pending plans without a running job were left by an interrupted
          // server; those of running jobs are still being written.
          yield* scheduling.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* laneOf(sessionId)).running === 0) {
                yield* store.abandonPending(sessionId);
              }
            }),
          );
          yield* store.refreshIncomplete;
        });

        const upcoming = Effect.fn("Curriculum.upcoming")(function* (
          sessionId: SessionId,
          limit: number,
        ) {
          const candidates = yield* store.candidates(
            sessionId,
            catalog.version,
          );
          if (candidates.length === 0) {
            return [];
          }
          const { estimates } = yield* currentEstimates;
          return candidates
            .filter((candidate) => {
              const target = byId.get(candidate.targetId);
              // Reviews only ever concern established targets; anything else
              // waits while a prerequisite needs revisiting.
              return (
                target !== undefined &&
                (candidate.role === "review" || eligible(estimates, target))
              );
            })
            .slice(0, limit)
            .map((candidate): PracticeItem => ({
              audioUrl: audioPath(candidate.sentenceId),
              english: candidate.english,
              mode: null,
              sentenceId: candidate.sentenceId,
              track: "curriculum",
            }));
        });

        return Curriculum.of({
          catalog,
          idle: FiberSet.awaitEmpty(jobs),
          reconcile,
          replenish,
          upcoming,
        });
      }),
    );

  public static readonly layer = Curriculum.layerWith(pilotCatalog);
}

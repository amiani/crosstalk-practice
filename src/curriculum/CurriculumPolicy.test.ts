import { describe, expect, it } from "vitest";

import type { Catalog } from "./Catalog.ts";
import { validateCatalog } from "./Catalog.ts";
import { pilotCatalog } from "./catalog/pilot.ts";
import {
  activeTargets,
  availableBackground,
  classifyObservation,
  estimateTargets,
  selectNext,
} from "./CurriculumPolicy.ts";
import type {
  Observation,
  Selection,
  SentencePlan,
  SentenceRole,
  TargetEstimate,
} from "./CurriculumPolicy.ts";

const start = Date.UTC(2026, 0, 1);
const minute = 60 * 1000;

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  contentKey: "coffee",
  family: "family-a",
  order: 0,
  position: 0,
  respondedAt: start,
  role: "teaching",
  sentenceId: "s0",
  startedPlaybacks: 1,
  targetId: "participants-i-you",
  targetRevision: 1,
  traceComplete: true,
  translationRevealed: false,
  understood: true,
  usable: true,
  ...overrides,
});

type Learner = (plan: SentencePlan, index: number) => Partial<Observation>;

/**
 * Runs the scheduler against a simulated learner for `count` sentences,
 * answering each before the next is chosen, one minute apart.
 */
const simulate = (
  count: number,
  learner: Learner,
  catalog: Catalog = pilotCatalog,
) => {
  const history: Array<Selection> = [];
  const observations: Array<Observation> = [];
  const plans: Array<SentencePlan> = [];
  let estimates: ReadonlyMap<string, TargetEstimate> = estimateTargets(
    catalog,
    [],
    start,
  );
  for (let index = 0; index < count; index += 1) {
    const now = start + index * minute;
    const plan = selectNext({
      answeredCount: observations.length,
      catalog,
      estimates,
      history,
      now,
    });
    if (plan === undefined) {
      break;
    }
    plans.push(plan);
    history.push({ role: plan.role, targetId: plan.targetId });
    observations.push(
      observation({
        contentKey: `content-${index % 5}`,
        family: `${plan.targetId}-${plan.role}-${Math.floor(index / 7)}`,
        order: index,
        position: index,
        respondedAt: now,
        role: plan.role,
        sentenceId: `s${index}`,
        targetId: plan.targetId,
        targetRevision: plan.targetRevision,
        ...learner(plan, index),
      }),
    );
    estimates = estimateTargets(catalog, observations, now);
  }
  return { estimates, observations, plans };
};

const statusOf = (estimates: ReadonlyMap<string, TargetEstimate>, id: string) =>
  estimates.get(id)?.status;

const withEstablished = (
  targets: ReadonlyArray<string>,
): ReadonlyMap<string, TargetEstimate> =>
  new Map(
    [...estimateTargets(pilotCatalog, [], start)].map(([id, estimate]) => [
      id,
      targets.includes(id) ? { ...estimate, status: "established" } : estimate,
    ]),
  );

describe("pilot catalog", () => {
  it("is structurally sound", () => {
    expect(validateCatalog(pilotCatalog)).toEqual([]);
  });

  it("does not assess form rules a comprehension response cannot isolate", () => {
    const ids = pilotCatalog.targets.map((target) => target.id).join(" ");
    for (const rule of ["vowel", "gradation", "verb-type", "word-type"]) {
      expect(ids).not.toContain(rule);
    }
  });

  it("is marked as awaiting a Finnish reviewer", () => {
    expect(
      pilotCatalog.targets.every((target) => target.review === "unreviewed"),
    ).toBe(true);
    expect(pilotCatalog.version).toContain("unreviewed");
  });

  it("reports unknown prerequisites, duplicates and cycles", () => {
    const [first, second] = pilotCatalog.targets;
    if (first === undefined || second === undefined) {
      throw new Error("pilot catalog too small");
    }
    const issues = validateCatalog({
      ...pilotCatalog,
      targets: [
        { ...first, prerequisites: [second.id] },
        { ...second, prerequisites: [first.id, "missing"] },
        { ...second, prerequisites: [first.id] },
      ],
    });
    expect(issues.some((issue) => issue.includes("Duplicate target"))).toBe(
      true,
    );
    expect(
      issues.some((issue) => issue.includes("unknown target missing")),
    ).toBe(true);
    expect(issues.some((issue) => issue.includes("cycle"))).toBe(true);
    expect(issues).toContain("No target can be taught first");
  });
});

describe("classifyObservation", () => {
  it("separates unaided, replayed, supported and unfair listens", () => {
    expect(classifyObservation(observation())).toBe("clean");
    expect(classifyObservation(observation({ startedPlaybacks: 3 }))).toBe(
      "replayed",
    );
    expect(
      classifyObservation(observation({ translationRevealed: true })),
    ).toBe("supported");
    expect(classifyObservation(observation({ understood: false }))).toBe(
      "failure",
    );
    expect(
      classifyObservation(observation({ understood: false, usable: false })),
    ).toBe("ambiguous");
  });

  it("never treats missing telemetry as an unaided success", () => {
    expect(classifyObservation(observation({ traceComplete: false }))).toBe(
      "unverified",
    );
    expect(classifyObservation(observation({ startedPlaybacks: null }))).toBe(
      "unverified",
    );
  });
});

describe("estimateTargets", () => {
  it("counts a sentence once and ignores other revisions", () => {
    const estimates = estimateTargets(
      pilotCatalog,
      [
        observation({ order: 0 }),
        observation({ order: 1 }),
        observation({ order: 2, sentenceId: "old", targetRevision: 99 }),
      ],
      start,
    );
    expect(estimates.get("participants-i-you")?.exposures).toBe(1);
  });

  it("caps positive weight from one family on one day", () => {
    const repeated = Array.from({ length: 10 }, (_, index) =>
      observation({ order: index, role: "transfer", sentenceId: `s${index}` }),
    );
    const estimate = estimateTargets(pilotCatalog, repeated, start).get(
      "participants-i-you",
    );
    expect(estimate?.independentSuccesses).toBe(10);
    expect(estimate?.support).toBeCloseTo(2 / 3);
  });

  it("relaxes old evidence toward the prior rather than toward failure", () => {
    const failures = [observation({ understood: false })];
    const fresh = estimateTargets(pilotCatalog, failures, start).get(
      "participants-i-you",
    );
    const later = estimateTargets(
      pilotCatalog,
      failures,
      start + 365 * 24 * 60 * minute,
    ).get("participants-i-you");
    expect(fresh?.support).toBeLessThan(later?.support ?? 0);
    expect(later?.support).toBeLessThanOrEqual(0.5);
    expect(later?.support).toBeCloseTo(0.5, 2);
  });
});

describe("selectNext", () => {
  it("starts with root targets only", () => {
    const { plans } = simulate(1, () => ({}));
    const [first] = plans;
    expect(first?.activeSet).toEqual([
      "participants-i-you",
      "negation-present",
      "question-yes-no",
      "question-words",
    ]);
    expect(first?.role).toBe("teaching");
    expect(first?.supportingTargets).toEqual([]);
    expect(first?.backgroundGrammar).toEqual(["background-copula-statements"]);
  });

  it("introduces later eligible targets in catalog order when earlier ones are established", () => {
    const established = withEstablished([
      "participants-i-you",
      "negation-present",
    ]);
    const active = activeTargets({
      answeredCount: 0,
      catalog: pilotCatalog,
      estimates: established,
      history: [],
      now: start,
    }).map((target) => target.id);
    expect(active).toEqual([
      "question-yes-no",
      "question-words",
      "origin-from",
      "participants-third-person",
    ]);
  });

  it("allows background grammar only after its targets are established", () => {
    const ids = (targets: ReadonlyArray<string>) =>
      availableBackground(pilotCatalog, withEstablished(targets)).map(
        (grammar) => grammar.id,
      );
    expect(ids([])).toEqual(["background-copula-statements"]);
    expect(ids(["participants-i-you"])).toContain(
      "background-present-verbs-type-1",
    );
    expect(ids(["participants-i-you"])).not.toContain(
      "background-present-verbs-all-types",
    );
  });

  it("establishes targets and unlocks dependants when the learner understands", () => {
    const { estimates, plans } = simulate(200, () => ({}));
    const established = pilotCatalog.targets.filter(
      (target) => statusOf(estimates, target.id) === "established",
    );
    expect(established.length).toBeGreaterThanOrEqual(6);
    expect(plans.some((plan) => plan.targetId === "possession-negated")).toBe(
      true,
    );
    const roles = new Set<SentenceRole>(plans.map((plan) => plan.role));
    expect([...roles].toSorted()).toEqual(["review", "teaching", "transfer"]);
  });

  it("only teaches a target once its prerequisites are established", () => {
    const { plans, observations } = simulate(200, () => ({}));
    plans.forEach((plan, index) => {
      const estimates = estimateTargets(
        pilotCatalog,
        observations.slice(0, index),
        start + index * minute,
      );
      const target = pilotCatalog.targets.find(
        (candidate) => candidate.id === plan.targetId,
      );
      for (const prerequisite of target?.prerequisites ?? []) {
        expect(statusOf(estimates, prerequisite)).toBe("established");
      }
    });
  });

  it("never establishes anything from failures or translation-supported successes", () => {
    for (const learner of [
      () => ({ understood: false }),
      () => ({ translationRevealed: true }),
      () => ({ traceComplete: false }),
    ]) {
      const { estimates, plans } = simulate(120, learner);
      expect(
        pilotCatalog.targets.every(
          (target) => statusOf(estimates, target.id) !== "established",
        ),
      ).toBe(true);
      expect(new Set(plans.map((plan) => plan.targetId)).size).toBe(4);
    }
  });

  it("simplifies after repeated failures", () => {
    const { plans } = simulate(12, () => ({ understood: false }));
    expect(plans.slice(9).every((plan) => plan.easier)).toBe(true);
    expect(plans.slice(0, 3).some((plan) => plan.easier)).toBe(false);
  });

  it("interleaves active targets without starving any", () => {
    const { plans } = simulate(60, (_, index) => ({
      understood: index % 3 !== 0,
    }));
    for (let index = 0; index + 6 <= plans.length; index += 1) {
      const window = plans.slice(index, index + 6);
      for (const target of window[0]?.activeSet ?? []) {
        if (window.every((plan) => plan.activeSet.includes(target))) {
          expect(window.some((plan) => plan.targetId === target)).toBe(true);
        }
      }
      for (let run = 0; run + 3 <= window.length; run += 1) {
        const [a, b, c] = window.slice(run, run + 3);
        expect(a?.targetId === b?.targetId && b?.targetId === c?.targetId).toBe(
          false,
        );
      }
    }
  });

  it("returns a target to revisit when reviews fail, and recovers it", () => {
    const failing = new Set<string>();
    // A small catalog runs out of new targets, so reviews come quickly.
    const catalog = {
      ...pilotCatalog,
      targets: pilotCatalog.targets.slice(0, 4),
    };
    const { estimates, plans } = simulate(
      260,
      (plan, index) => {
        if (index === 150) {
          failing.add("participants-i-you");
        }
        return {
          understood: !(failing.has(plan.targetId) && plan.role === "review"),
        };
      },
      catalog,
    );
    expect(
      plans
        .slice(150)
        .some(
          (plan) =>
            plan.targetId === "participants-i-you" && plan.role !== "review",
        ),
    ).toBe(true);
    expect(statusOf(estimates, "participants-i-you")).not.toBe("unintroduced");
  });

  it("is deterministic", () => {
    const learner: Learner = (_, index) => ({ understood: index % 4 !== 1 });
    expect(simulate(80, learner).plans).toEqual(simulate(80, learner).plans);
  });

  it("does not require all active targets to share a sentence", () => {
    const estimates = estimateTargets(pilotCatalog, [], start);
    const active = activeTargets({
      answeredCount: 0,
      catalog: pilotCatalog,
      estimates,
      history: [],
      now: start,
    });
    expect(active.length).toBe(4);
  });

  it("lets introduced active targets support each other", () => {
    const { plans } = simulate(12, () => ({}));
    const later = plans.at(-1);
    expect(later?.supportingTargets.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.supportingTargets).not.toContain(plan.targetId);
    }
  });

  it("does not let a struggling target support others", () => {
    const { estimates, plans } = simulate(12, (plan) => ({
      understood: plan.targetId !== "question-words",
    }));
    expect(estimates.get("question-words")?.struggling).toBe(true);
    expect(plans.at(-1)?.supportingTargets).not.toContain("question-words");
  });

  it("checks an otherwise ready target with a transfer sentence", () => {
    const target = "negation-present";
    const observations = Array.from({ length: 10 }, (_, index) =>
      observation({
        contentKey: `content-${index}`,
        family: `family-${index}`,
        order: index,
        position: index,
        respondedAt: start + index * minute,
        sentenceId: `s${index}`,
        targetId: target,
      }),
    );
    const now = start + 10 * minute;
    const estimates = estimateTargets(pilotCatalog, observations, now);
    expect(estimates.get(target)?.awaitingTransferCheck).toBe(true);
    expect(statusOf(estimates, target)).toBe("learning");
    // Teaching is behind in the role mix, so it would otherwise win.
    const history: Array<Selection> = [
      ...observations.map(() => ({
        role: "teaching" as const,
        targetId: target,
      })),
      ...Array.from({ length: 3 }, () => ({
        role: "transfer" as const,
        targetId: "participants-i-you",
      })),
    ];
    const input = {
      answeredCount: 10,
      catalog: pilotCatalog,
      estimates,
      history,
      now,
    };
    const next = selectNext(input);
    expect(next?.targetId).toBe(target);
    expect(next?.role).toBe("transfer");

    // Only one check is outstanding at a time.
    const waiting = selectNext({
      ...input,
      history: [
        ...history,
        { answered: false, role: "transfer", targetId: target },
        { role: "teaching", targetId: "question-words" },
      ],
    });
    expect(waiting?.role === "transfer" && waiting.targetId === target).toBe(
      false,
    );
  });

  it("passes over a cooling target while others can be taught", () => {
    const estimates = estimateTargets(pilotCatalog, [], start);
    const input = {
      answeredCount: 0,
      catalog: pilotCatalog,
      estimates,
      history: [],
      now: start,
    };
    const first = selectNext(input);
    expect(first).toBeDefined();
    const cooled = selectNext({
      ...input,
      cooling: new Set([first?.targetId ?? ""]),
    });
    expect(cooled?.targetId).not.toBe(first?.targetId);
    const all = new Set(activeTargets(input).map((target) => target.id));
    expect(selectNext({ ...input, cooling: all })?.targetId).toBe(
      first?.targetId,
    );
  });
});

/**
 * The curriculum's coverage of grammar and function concepts: small, versioned
 * learning targets in teaching order, with prerequisites, the Finnish that
 * realises them, and the sources they were drawn from. Background grammar
 * makes sentences possible without being assessed. Trusted, in-repository
 * content: validate it with {@link validateCatalog} in tests rather than at
 * runtime.
 */

export type TargetId = string;

/** Spoken Finnish is how crosstalk sounds; standard forms are also listed. */
export type Register = "spoken" | "standard";

export interface Example {
  readonly english: string;
  readonly finnish: string;
}

/** One way Finnish expresses a target, in one register. */
export interface Realisation {
  readonly examples: ReadonlyArray<Example>;
  /** The forms or construction, described for authors and reviewers. */
  readonly form: string;
  readonly register: Register;
}

export interface SourceReference {
  /** Where in the source the coverage appears, e.g. a chapter. */
  readonly locator: string;
  readonly title: string;
  readonly url: string;
}

/**
 * Unreviewed content is a draft awaiting a Finnish reviewer; it may be used
 * for personal practice, and every sentence records the catalog version so
 * its evidence can be told apart once review changes a target.
 */
export type ReviewStatus = "unreviewed" | "reviewed";

export interface LearningTarget {
  /** What must be distinguished for the target to change the meaning. */
  readonly contrast: string;
  /** Constructions an author must not introduce alongside this target. */
  readonly exclusions: ReadonlyArray<string>;
  readonly id: TargetId;
  /** The meaning the learner comes to recognise, in plain English. */
  readonly meaning: string;
  /** Targets that must be established before this one is taught. */
  readonly prerequisites: ReadonlyArray<TargetId>;
  readonly realisations: ReadonlyArray<Realisation>;
  readonly review: ReviewStatus;
  /** Bump when the meaning or contrast changes; evidence is per revision. */
  readonly revision: number;
  readonly sources: ReadonlyArray<SourceReference>;
  /** How examples may differ from one another without changing the target. */
  readonly variationDimensions: ReadonlyArray<string>;
}

/**
 * Grammar a sentence may use once its required targets are established. It
 * is never assessed: forms such as vowel harmony or verb types matter for
 * recognising words, but a comprehension response cannot isolate them.
 */
export interface BackgroundGrammar {
  readonly description: string;
  readonly examples: ReadonlyArray<Example>;
  readonly id: string;
  /** Targets that must be established before sentences may use this grammar. */
  readonly requires: ReadonlyArray<TargetId>;
  readonly sources: ReadonlyArray<SourceReference>;
}

export interface Catalog {
  readonly background: ReadonlyArray<BackgroundGrammar>;
  /** In teaching order: earlier eligible targets are introduced first. */
  readonly targets: ReadonlyArray<LearningTarget>;
  /** Stored with every curriculum sentence; bump on any content change. */
  readonly version: string;
}

/**
 * Structural problems that would make selection unsound: duplicate IDs,
 * unknown or cyclic prerequisites, content without Finnish or sources, and no
 * starting point.
 */
export const validateCatalog = (catalog: Catalog): ReadonlyArray<string> => {
  const issues: Array<string> = [];
  const ids = new Set<TargetId>();
  for (const target of catalog.targets) {
    if (ids.has(target.id)) {
      issues.push(`Duplicate target ${target.id}`);
    }
    ids.add(target.id);
  }
  const backgroundIds = new Set<string>();
  for (const grammar of catalog.background) {
    if (backgroundIds.has(grammar.id) || ids.has(grammar.id)) {
      issues.push(`Duplicate background grammar ${grammar.id}`);
    }
    backgroundIds.add(grammar.id);
    if (grammar.examples.length === 0) {
      issues.push(`${grammar.id} has no examples`);
    }
    if (grammar.sources.length === 0) {
      issues.push(`${grammar.id} has no source`);
    }
    for (const required of grammar.requires) {
      if (!ids.has(required)) {
        issues.push(`${grammar.id} requires unknown target ${required}`);
      }
    }
  }
  if (!catalog.background.some((grammar) => grammar.requires.length === 0)) {
    issues.push("No background grammar is available at the start");
  }
  for (const target of catalog.targets) {
    if (!Number.isInteger(target.revision) || target.revision < 1) {
      issues.push(`${target.id} has an invalid revision`);
    }
    if (target.realisations.length === 0) {
      issues.push(`${target.id} has no realisations`);
    }
    for (const realisation of target.realisations) {
      if (realisation.examples.length === 0) {
        issues.push(
          `${target.id} has a ${realisation.register} form without examples`,
        );
      }
    }
    if (target.sources.length === 0) {
      issues.push(`${target.id} has no source`);
    }
    for (const prerequisite of target.prerequisites) {
      if (!ids.has(prerequisite)) {
        issues.push(`${target.id} requires unknown target ${prerequisite}`);
      }
      if (prerequisite === target.id) {
        issues.push(`${target.id} requires itself`);
      }
    }
  }
  if (!catalog.targets.some((target) => target.prerequisites.length === 0)) {
    issues.push("No target can be taught first");
  }
  const cycle = findCycle(catalog);
  if (cycle !== undefined) {
    issues.push(`Prerequisite cycle: ${cycle.join(" -> ")}`);
  }
  return issues;
};

const findCycle = (catalog: Catalog): ReadonlyArray<TargetId> | undefined => {
  const byId = new Map(catalog.targets.map((target) => [target.id, target]));
  const done = new Set<TargetId>();
  const visit = (
    id: TargetId,
    path: ReadonlyArray<TargetId>,
  ): ReadonlyArray<TargetId> | undefined => {
    if (path.includes(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    if (done.has(id)) {
      return undefined;
    }
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) {
      const cycle = visit(prerequisite, [...path, id]);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    done.add(id);
    return undefined;
  };
  for (const target of catalog.targets) {
    const cycle = visit(target.id, []);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
};

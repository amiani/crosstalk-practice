import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import type { Prompt } from "effect/unstable/ai";

import { pilotCatalog } from "./catalog/pilot.ts";
import { CurriculumAuthor } from "./CurriculumAuthor.ts";
import type { CurriculumBrief } from "./CurriculumAuthor.ts";
import {
  llmCurriculumAuthorLayer,
  realisationOf,
} from "./LlmCurriculumAuthor.ts";

interface Call {
  readonly objectName: string;
  readonly system: string;
  readonly user: string;
}

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const targetById = (id: string) => {
  const target = pilotCatalog.targets.find((candidate) => candidate.id === id);
  if (target === undefined) {
    throw new Error(`Missing pilot target ${id}`);
  }
  return target;
};

const possession = targetById("possession-have");
const participants = targetById("participants-i-you");

const brief = (overrides: Partial<CurriculumBrief> = {}): CurriculumBrief => ({
  avoidContent: ["kissa"],
  background: pilotCatalog.background.slice(0, 1),
  candidates: 3,
  earlier: [],
  plan: {
    activeSet: [possession.id],
    backgroundGrammar: ["background-copula-statements"],
    easier: false,
    reason: "focus",
    role: "teaching",
    supportingTargets: [participants.id],
    targetId: possession.id,
    targetRevision: possession.revision,
  },
  recent: [
    {
      english: "You have a car.",
      finnish: "Sulla on auto.",
      targetId: possession.id,
    },
  ],
  register: "Spoken Finnish (mä/sä)",
  supporting: [participants],
  target: possession,
  topics: ["pets"],
  vocabulary: [
    { english: "dog", heard: "koira", lemma: "koira" },
    { english: "cat", heard: "kissa", lemma: "kissa" },
  ],
  ...overrides,
});

const draft = (finnish: string, overrides: Record<string, unknown> = {}) => ({
  contentWords: ["koira"],
  english: `English for ${finnish}`,
  finnish,
  realisation: "mulla / sulla / name + -lla on + nominative",
  ...overrides,
});

const verdict = (index: number, overrides: Record<string, unknown> = {}) => ({
  grammatical: true,
  index,
  natural: true,
  note: "",
  onlyAllowedConstructions: true,
  registerConsistent: true,
  standalone: true,
  targetPresent: true,
  translationAccurate: true,
  vocabularyGrounded: true,
  ...overrides,
});

const textOf = (message: Prompt.Message | undefined): string => {
  if (message === undefined) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
};

const badKey = AiError.make({
  method: "generateObject",
  module: "LanguageModel",
  reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
});

interface Script {
  readonly sentences: ReadonlyArray<unknown>;
  /** Verdicts, given the drafts the reviewer received. */
  readonly verdicts?: (count: number) => ReadonlyArray<unknown>;
  readonly fail?: boolean;
}

const fakeModel = (calls: Ref.Ref<ReadonlyArray<Call>>, script: Script) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Effect.gen(function* () {
          const format = options.responseFormat;
          const objectName = format.type === "json" ? format.objectName : "";
          const [system, user] = options.prompt.content;
          yield* Ref.update(calls, (all) => [
            ...all,
            { objectName, system: textOf(system), user: textOf(user) },
          ]);
          if (script.fail === true) {
            return yield* badKey;
          }
          const reviewed = (textOf(user).match(/^\d+\. Finnish:/gm) ?? [])
            .length;
          const value =
            objectName === "curriculum_sentences"
              ? { sentences: script.sentences }
              : {
                  verdicts: (
                    script.verdicts ??
                    ((count) =>
                      Array.from({ length: count }, (_, index) =>
                        verdict(index),
                      ))
                  )(reviewed),
                };
          return [{ text: toJson(value), type: "text" as const }];
        }),
      streamText: () => Stream.die("not used"),
    }),
  );

const run = (script: Script, input: CurriculumBrief = brief()) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const exit = yield* Effect.gen(function* () {
      const author = yield* CurriculumAuthor;
      return yield* author.write(input);
    }).pipe(
      Effect.provide(
        llmCurriculumAuthorLayer.pipe(Layer.provide(fakeModel(calls, script))),
      ),
      Effect.exit,
    );
    return { calls: yield* Ref.get(calls), exit };
  });

const accepted = (script: Script, input?: CurriculumBrief) =>
  Effect.gen(function* () {
    const { calls, exit } = yield* run(script, input);
    if (Exit.isFailure(exit)) {
      return assert.fail(`write failed: ${String(exit.cause)}`);
    }
    return {
      calls,
      rejected: exit.value.rejected,
      written: exit.value.accepted,
    };
  });

describe("LlmCurriculumAuthor", () => {
  it.effect("briefs the writer and reviewer on the target and its limits", () =>
    Effect.gen(function* () {
      const { calls } = yield* accepted({
        sentences: [draft("Mulla on koira.")],
      });
      const [writer, reviewer] = calls;
      assert.strictEqual(writer?.objectName, "curriculum_sentences");
      assert.include(writer?.system, "Isolate the primary target");
      assert.include(writer?.system, "Its contrast must carry meaning");
      for (const call of [writer, reviewer]) {
        // Target, contrast, realisations and exclusions.
        assert.include(call?.user, possession.meaning);
        assert.include(call?.user, possession.contrast);
        assert.include(
          call?.user,
          '[spoken, preferred] form: "mulla / sulla / name + -lla on + nominative"',
        );
        assert.include(
          call?.user,
          '[standard] form: "minulla / sinulla / name + -lla on + nominative"',
        );
        assert.include(call?.user, '"Pedrolla on koira." (Pedro has a dog.)');
        assert.include(call?.user, "negated possession");
        // Supporting targets use the preferred register.
        assert.include(
          call?.user,
          "mä / sä with first- and second-person verb forms",
        );
        assert.notInclude(call?.user, "minä / sinä");
        // Background grammar, vocabulary, register and topics.
        assert.include(
          call?.user,
          "Affirmative present statements with a noun or name subject",
        );
        assert.include(call?.user, "- koira | koira | dog");
        assert.include(
          call?.user,
          "Register: Spoken Finnish (mä/sä) (prefer spoken realisations)",
        );
        assert.include(call?.user, "Topics: pets");
      }
      assert.include(writer?.user, "Role: teaching");
      assert.include(writer?.user, "Near-structural repetition");
      assert.notInclude(writer?.user, "struggling");
      assert.include(writer?.user, "Content combinations to avoid");
      assert.include(writer?.user, "- kissa");
      assert.include(writer?.user, "- Sulla on auto. — You have a car.");
      assert.include(writer?.user, "Write 3 new sentences.");
      assert.strictEqual(reviewer?.objectName, "curriculum_review");
      for (const flag of [
        "targetPresent",
        "onlyAllowedConstructions",
        "vocabularyGrounded",
        "registerConsistent",
      ]) {
        assert.include(reviewer?.system, flag);
      }
      assert.include(reviewer?.user, "0. Finnish: Mulla on koira.");
      assert.include(
        reviewer?.user,
        "Realisation: mulla / sulla / name + -lla on + nominative",
      );
    }),
  );

  it.effect("drops repeats before paying for review", () =>
    Effect.gen(function* () {
      const { calls, rejected, written } = yield* accepted(
        {
          sentences: [
            draft("sulla on auto"),
            draft("Mulla on tikku!"),
            draft("Mulla on koira."),
            draft("Mulla on koira"),
            draft("Mulla on talo.", { english: "Mulla on talo." }),
          ],
        },
        brief({
          earlier: [
            {
              english: "I have a stick.",
              finnish: "Mulla on tikku.",
              targetId: possession.id,
            },
          ],
        }),
      );
      const [writer, reviewer] = calls;
      assert.include(writer?.user, "Earlier sentences for this target");
      assert.include(writer?.user, "- Mulla on tikku.");
      assert.include(writer?.user, "structure e.g.");
      assert.include(reviewer?.user, "0. Finnish: Mulla on koira.");
      assert.notInclude(reviewer?.user, "1. Finnish");
      assert.deepStrictEqual(
        written.map((sentence) => sentence.finnish),
        ["Mulla on koira."],
      );
      assert.deepStrictEqual(
        rejected.map((draft) => draft.reason),
        [
          "duplicate of an earlier sentence",
          "duplicate of an earlier sentence",
          "duplicate of an earlier sentence",
          "translation repeats the Finnish",
        ],
      );
    }),
  );

  it.effect("guides transfer, review and easier sentences", () =>
    Effect.gen(function* () {
      const base = brief();
      const guidance = [
        [{ ...base.plan, role: "transfer" as const }, "Role: transfer"],
        [{ ...base.plan, role: "review" as const }, "Role: review"],
        [{ ...base.plan, easier: true }, "shortest, simplest sentences"],
      ] as const;
      for (const [plan, expected] of guidance) {
        const { calls } = yield* accepted(
          { sentences: [draft("Mulla on koira.")] },
          { ...base, plan },
        );
        assert.include(calls[0]?.user, expected);
      }
    }),
  );

  it.effect("prefers standard realisations for a standard register", () =>
    Effect.gen(function* () {
      const { calls } = yield* accepted(
        {
          sentences: [
            draft("Minulla on koira.", {
              realisation: "minulla / sinulla / name + -lla on + nominative",
            }),
          ],
        },
        brief({ register: "Standard written Finnish" }),
      );
      assert.include(calls[0]?.user, '[standard, preferred] form: "minulla /');
      assert.include(calls[0]?.user, "minä / sinä");
    }),
  );

  it.effect("returns accepted drafts trimmed and in writer order", () =>
    Effect.gen(function* () {
      const { written } = yield* accepted({
        sentences: [
          draft("  Mulla on koira. ", {
            contentWords: [" Koira ", ""],
            english: " I have a dog. ",
          }),
          draft("Sulla on koira ja kissa.", {
            contentWords: ["koira", "kissa"],
          }),
        ],
        verdicts: (count) =>
          Array.from({ length: count }, (_, index) =>
            verdict(index, { note: ` note ${index} ` }),
          ),
      });
      assert.deepStrictEqual(written, [
        {
          contentWords: ["Koira"],
          english: "I have a dog.",
          finnish: "Mulla on koira.",
          realisation: "mulla / sulla / name + -lla on + nominative",
          reviewNote: "note 0",
        },
        {
          contentWords: ["koira", "kissa"],
          english: "English for Sulla on koira ja kissa.",
          finnish: "Sulla on koira ja kissa.",
          realisation: "mulla / sulla / name + -lla on + nominative",
          reviewNote: "note 1",
        },
      ]);
    }),
  );

  for (const flag of [
    "grammatical",
    "natural",
    "translationAccurate",
    "standalone",
    "targetPresent",
    "onlyAllowedConstructions",
    "vocabularyGrounded",
    "registerConsistent",
  ]) {
    it.effect(`rejects drafts the reviewer marks not ${flag}`, () =>
      Effect.gen(function* () {
        const { written } = yield* accepted({
          sentences: [draft("Mulla on koira."), draft("Sulla on koira.")],
          verdicts: () => [verdict(0, { [flag]: false }), verdict(1)],
        });
        assert.deepStrictEqual(
          written.map((sentence) => sentence.finnish),
          ["Sulla on koira."],
        );
      }),
    );
  }

  it.effect("rejects drafts the reviewer gave no verdict", () =>
    Effect.gen(function* () {
      const { written } = yield* accepted({
        sentences: [draft("Mulla on koira."), draft("Sulla on koira.")],
        verdicts: () => [verdict(1)],
      });
      assert.deepStrictEqual(
        written.map((sentence) => sentence.finnish),
        ["Sulla on koira."],
      );
    }),
  );

  it.effect("drops reused, empty and misattributed drafts before review", () =>
    Effect.gen(function* () {
      const { calls, rejected, written } = yield* accepted({
        sentences: [
          draft("Mulla on kissa.", { contentWords: [" KISSA "] }),
          draft("Mulla on koira.", { realisation: "mulla on" }),
          draft("Sulla on koira.", { contentWords: [" "] }),
          draft("  ", {}),
          draft("Sulla on iso koira.", { contentWords: ["koira", "iso"] }),
        ],
      });
      assert.deepStrictEqual(
        written.map((sentence) => sentence.finnish),
        ["Sulla on iso koira."],
      );
      const reviewer = calls[1]?.user ?? "";
      assert.include(reviewer, "0. Finnish: Sulla on iso koira.");
      assert.notInclude(reviewer, "1. Finnish:");
      assert.deepStrictEqual(
        rejected.map((draft) => draft.reason),
        [
          "reuses content combination kissa",
          'unknown realisation "mulla on"',
          "no content words",
          "empty sentence or translation",
        ],
      );
    }),
  );

  it.effect("accepts a form copied without its remarks or case", () =>
    Effect.gen(function* () {
      const { written } = yield* accepted({
        sentences: [
          draft("Mulla on koira.", {
            realisation: "  Mulla / sulla / NAME + -lla on + nominative ",
          }),
        ],
      });
      assert.deepStrictEqual(
        written.map((sentence) => sentence.realisation),
        ["mulla / sulla / name + -lla on + nominative"],
      );
    }),
  );

  it("matches forms whose remarks were dropped", () => {
    const target = {
      ...brief().target,
      realisations: [
        {
          examples: [
            {
              english: "The cat is in the house.",
              finnish: "Kissa on talossa.",
            },
          ],
          form: "-ssa / -ssä (inessive)",
          register: "standard" as const,
        },
      ],
    };
    assert.strictEqual(
      realisationOf("-ssa / -ssä", target),
      "-ssa / -ssä (inessive)",
    );
    assert.isUndefined(realisationOf("-sta / -stä", target));
  });

  it.effect("reports reviewer rejections with their notes", () =>
    Effect.gen(function* () {
      const { rejected } = yield* accepted({
        sentences: [draft("Mulla on koira.")],
        verdicts: () => [verdict(0, { natural: false, note: "stilted" })],
      });
      assert.deepStrictEqual(rejected, [
        { finnish: "Mulla on koira.", reason: "stilted" },
      ]);
    }),
  );

  it.effect(
    "skips review when no draft survives the deterministic checks",
    () =>
      Effect.gen(function* () {
        const { calls, written } = yield* accepted({
          sentences: [draft("Mulla on kissa.", { contentWords: ["kissa"] })],
        });
        assert.deepStrictEqual(written, []);
        assert.strictEqual(calls.length, 1);
      }),
  );

  it.effect("fails with an AuthoringError when the model fails", () =>
    Effect.gen(function* () {
      const { exit } = yield* run({ fail: true, sentences: [] });
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find(
          (reason) => reason._tag === "Fail",
        );
        assert.strictEqual(error?._tag, "Fail");
        if (error?._tag === "Fail") {
          assert.strictEqual(error.error._tag, "AuthoringError");
          assert.strictEqual(error.error.operation, "CurriculumAuthor.write");
        }
      }
    }),
  );
});

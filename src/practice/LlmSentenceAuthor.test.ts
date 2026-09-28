import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { Prompt } from "effect/unstable/ai";

import { SentenceId } from "../domain/model.ts";
import type { PracticeMode, SessionProfile } from "../domain/model.ts";
import { llmSentenceAuthorLayer } from "./LlmSentenceAuthor.ts";
import { SentenceAuthor } from "./SentenceAuthor.ts";

/** One structured-output request the author made. */
interface Call {
  readonly objectName: string;
  readonly system: string;
  readonly user: string;
}

const struggleId = SentenceId.make("00000000-0000-4000-8000-000000000001");
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const profile: SessionProfile = {
  constructions: [{ description: "Partitive object", example: "Juon kahvia." }],
  discardedSnippets: 0,
  register: "Spoken Finnish",
  summary: "Talking about shopping",
  topics: ["shopping"],
  utterances: [{ english: "I buy bread.", finnish: "Ostan leipää." }],
  vocabulary: [{ english: "bread", heard: "leipää", lemma: "leipä" }],
};

const drafts = {
  sentences: [
    {
      english: "I buy bread from the shop.",
      finnish: "Ostan leipää kaupasta.",
      variationOf: null,
    },
    {
      english: "I'm buying bread because I'm hungry.",
      finnish: "Ostan leipää, koska olen nälkäinen.",
      variationOf: struggleId,
    },
  ],
};

const verdict = (index: number) => ({
  grammatical: true,
  index,
  natural: true,
  note: "",
  standalone: true,
  translationAccurate: true,
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

/**
 * A language model that answers the writer with fixed drafts and the reviewer
 * with verdicts that pass every quality check; in beginner review only the
 * first draft counts as a single clause.
 */
const fakeModel = (calls: Ref.Ref<ReadonlyArray<Call>>) =>
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
          const beginnerReview = textOf(system).includes("singleClause");
          const value =
            objectName === "practice_sentences"
              ? drafts
              : {
                  verdicts: beginnerReview
                    ? [
                        { ...verdict(0), singleClause: true },
                        { ...verdict(1), note: "koska", singleClause: false },
                      ]
                    : [verdict(0), verdict(1)],
                };
          return [{ text: toJson(value), type: "text" as const }];
        }),
      streamText: () => Stream.die("not used"),
    }),
  );

const write = (mode: PracticeMode) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const written = yield* Effect.gen(function* () {
      const author = yield* SentenceAuthor;
      return yield* author.writeSentences({
        count: 2,
        mode,
        profile,
        recent: [],
        struggles: [
          {
            english: "I'm buying bread because I'm hungry.",
            finnish: "Ostan leipää, koska olen nälkäinen.",
            sentenceId: struggleId,
          },
        ],
      });
    }).pipe(
      Effect.provide(
        llmSentenceAuthorLayer.pipe(Layer.provide(fakeModel(calls))),
      ),
    );
    return { calls: yield* Ref.get(calls), written };
  });

describe("LlmSentenceAuthor", () => {
  it.effect("asks for and enforces single clauses in beginner mode", () =>
    Effect.gen(function* () {
      const { calls, written } = yield* write("beginner");
      const [writer, review] = calls;
      assert.strictEqual(writer?.objectName, "practice_sentences");
      assert.include(writer?.system, "exactly one independent clause");
      // The existing constraints still apply.
      assert.include(writer?.system, "between 4 and 14 words");
      assert.include(writer?.system, "simpler variations");
      assert.include(writer?.user, "Write 2 new single-clause sentences.");
      assert.strictEqual(review?.objectName, "sentence_review");
      assert.include(review?.system, "singleClause");
      assert.deepStrictEqual(
        written.map((draft) => draft.finnish),
        ["Ostan leipää kaupasta."],
      );
    }),
  );

  it.effect("keeps the unrestricted rules in intermediate mode", () =>
    Effect.gen(function* () {
      const { calls, written } = yield* write("intermediate");
      const [writer, review] = calls;
      assert.notInclude(writer?.system, "exactly one independent clause");
      assert.include(writer?.system, "between 4 and 14 words");
      assert.include(writer?.user, "Write 2 new sentences.");
      assert.notInclude(review?.system, "singleClause");
      assert.deepStrictEqual(
        written.map((draft) => [draft.finnish, draft.variationOf]),
        [
          ["Ostan leipää kaupasta.", null],
          ["Ostan leipää, koska olen nälkäinen.", struggleId],
        ],
      );
    }),
  );
});

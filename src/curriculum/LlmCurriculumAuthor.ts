import { Effect, Layer, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { AiError } from "effect/unstable/ai";

import { retryAiCall } from "../ai/retryAiCall.ts";
import { normalizeSentence } from "../practice/normalize.ts";
import { AuthoringError } from "../practice/SentenceAuthor.ts";
import type { LearningTarget, Realisation, Register } from "./Catalog.ts";
import { CurriculumAuthor, contentKey } from "./CurriculumAuthor.ts";
import type {
  CurriculumBrief,
  CurriculumDraft,
  RejectedDraft,
} from "./CurriculumAuthor.ts";

const Drafts = Schema.Struct({
  sentences: Schema.Array(
    Schema.Struct({
      /** Lemmas of the nouns, verbs and adjectives used. */
      contentWords: Schema.Array(Schema.String),
      english: Schema.String,
      finnish: Schema.String,
      /** The target realisation used, copied from its form text. */
      realisation: Schema.String,
    }),
  ),
});

const Review = Schema.Struct({
  verdicts: Schema.Array(
    Schema.Struct({
      grammatical: Schema.Boolean,
      index: Schema.Int,
      natural: Schema.Boolean,
      note: Schema.String,
      onlyAllowedConstructions: Schema.Boolean,
      registerConsistent: Schema.Boolean,
      standalone: Schema.Boolean,
      targetPresent: Schema.Boolean,
      translationAccurate: Schema.Boolean,
      vocabularyGrounded: Schema.Boolean,
    }),
  ),
});
type Verdict = (typeof Review.Type.verdicts)[number];

/** Everyday words allowed when the familiar vocabulary has no suitable one. */
const COMMON_WORDS_RULE =
  "up to two extra very common everyday words that any beginner knows are always allowed; prefer the familiar vocabulary for everything else";

export const WRITER_INSTRUCTIONS = `You write Finnish listening-comprehension sentences for a native English speaker following a grammar curriculum. The learner only hears each sentence (no text), then judges whether they understood it; the English translation is shown only on request. Each sentence teaches one primary target: a small grammar or function-word concept.

Rules for every sentence:
- Isolate the primary target. Its contrast must carry meaning: understanding the sentence must depend on recognising the target, not just on guessing from the content words.
- Use only these constructions: the target itself, the listed supporting targets, and the available background grammar. Introduce no other grammar or function words, and never use the target's exclusions (a listed supporting target is allowed even if an exclusion would otherwise cover it).
- Background grammar is allowed but never the point of the sentence. Correct forms required by allowed constructions, including vowel harmony, consonant gradation and word or verb types, are part of them.
- Supporting targets are optional and exist to add variety: combine the primary target with at most one of them per sentence, so the sentences differ from each other and from earlier ones.
- Build content (nouns, verbs, adjectives) from the familiar vocabulary; ${COMMON_WORDS_RULE}.
- Catalog examples show structure only: never copy their content words (such as kahvi, koira, kissa) unless those words are in the familiar vocabulary or the common-word allowance.
- Follow the register: use the preferred realisation of the target and matching forms throughout.
- Keep sentences short and simple. One clause is best; there is no minimum length.
- Every sentence must make sense on its own, without drawings or the surrounding conversation.
- Never repeat an earlier or recent sentence, and make each of your sentences differ from the others in more than one word.
- Give an accurate, natural English translation.
- contentWords: the dictionary lemmas of the content words you used (nouns, verbs, adjectives), not pronouns or function words.
- realisation: copy exactly the form text of the target realisation you used, as listed.`;

export const REVIEW_INSTRUCTIONS = `You are a meticulous native Finnish editor and teacher reviewing sentences for a curriculum-driven listening course. The learner hears each sentence without text. Colloquial spoken Finnish is acceptable when it is natural. Each sentence must teach one primary target using only allowed constructions and familiar vocabulary; the brief below lists them.

For each numbered sentence, judge:
- grammatical: correct Finnish (standard or natural spoken forms).
- natural: something a native speaker would plausibly say.
- translationAccurate: the English translation faithfully conveys the Finnish.
- standalone: understandable without any surrounding context.
- targetPresent: the primary target is realised, and it carries meaning (understanding depends on recognising it).
- onlyAllowedConstructions: no grammar or function words beyond the target, the supporting targets and the available background grammar, and none of the target's exclusions (listed supporting targets are allowed even if an exclusion would otherwise cover them). Correct forms required by an allowed construction, including vowel harmony, consonant gradation and word or verb types, are not extra grammar.
- vocabularyGrounded: content words come from the familiar vocabulary, allowing ${COMMON_WORDS_RULE}.
- registerConsistent: the sentence follows the register consistently (no mixing of spoken and standard forms).
Be strict: when in doubt, mark false and explain briefly in note.`;

/** Spoken crosstalk calls for spoken realisations; otherwise standard ones. */
export const preferredRegister = (register: string): Register =>
  /spoken|colloquial|puhekiel/i.test(register) ? "spoken" : "standard";

const ROLE_GUIDANCE = {
  review:
    "Role: review. The learner met this target a while ago. Write fresh examples: a combination of content words not listed under 'Content combinations to avoid', so success shows the target was retained.",
  teaching:
    "Role: teaching. Deliberately repeat the target construction with familiar content. Near-structural repetition of the target's examples is fine, but each sentence must be a new complete sentence.",
  transfer:
    "Role: transfer. Test the target with a fresh combination of familiar content words not listed under 'Content combinations to avoid', so success shows understanding beyond memorised examples.",
} as const;

const EASIER_GUIDANCE =
  "The learner has been struggling with this target: make these the shortest, simplest sentences possible, with the most familiar words.";

const renderExamples = (
  examples: ReadonlyArray<{ finnish: string; english: string }>,
) =>
  examples
    .map((example) => `"${example.finnish}" (${example.english})`)
    .join("; ");

const renderRealisation = (realisation: Realisation, preferred: Register) =>
  `- [${realisation.register}${realisation.register === preferred ? ", preferred" : ""}] form: "${realisation.form}" — structure e.g. ${renderExamples(realisation.examples)}`;

const renderTarget = (target: LearningTarget, preferred: Register) => [
  `Primary target: ${target.meaning}`,
  `Contrast that must carry meaning: ${target.contrast}`,
  `Target realisations:`,
  ...target.realisations.map((realisation) =>
    renderRealisation(realisation, preferred),
  ),
  `Exclusions (never use, except listed supporting targets): ${target.exclusions.length > 0 ? target.exclusions.join("; ") : "none"}`,
];

/** A target's realisations in the preferred register, or all if it has none. */
const inRegister = (target: LearningTarget, preferred: Register) => {
  const matching = target.realisations.filter(
    (realisation) => realisation.register === preferred,
  );
  return matching.length > 0 ? matching : target.realisations;
};

/** The target, allowed constructions, vocabulary and register. */
const renderContext = (brief: CurriculumBrief): Array<string> => {
  const preferred = preferredRegister(brief.register);
  return [
    ...renderTarget(brief.target, preferred),
    "",
    "Supporting targets (already met by the learner; may be combined with the primary target):",
    ...(brief.supporting.length === 0
      ? ["- none"]
      : brief.supporting.map(
          (target) =>
            `- ${target.meaning}: ${inRegister(target, preferred)
              .map(
                (realisation) =>
                  `${realisation.form} (structure e.g. ${renderExamples(realisation.examples)})`,
              )
              .join("; ")}`,
        )),
    "",
    "Available background grammar (allowed, not assessed):",
    ...brief.background.map(
      (grammar) =>
        `- ${grammar.description} (structure e.g. ${renderExamples(grammar.examples)})`,
    ),
    "",
    "Familiar vocabulary (heard form | lemma | English):",
    ...brief.vocabulary.map(
      (item) => `- ${item.heard} | ${item.lemma} | ${item.english}`,
    ),
    "",
    `Register: ${brief.register} (prefer ${preferred} realisations)`,
    ...(brief.topics.length > 0 ? [`Topics: ${brief.topics.join(", ")}`] : []),
  ];
};

export const renderWriterBrief = (brief: CurriculumBrief): string => {
  const lines = [...renderContext(brief), "", ROLE_GUIDANCE[brief.plan.role]];
  if (brief.plan.easier) {
    lines.push(EASIER_GUIDANCE);
  }
  if (brief.avoidContent.length > 0) {
    lines.push(
      "",
      "Content combinations to avoid (lemmas already used together; use a different combination):",
      ...brief.avoidContent.map((key) => `- ${key.split("+").join(", ")}`),
    );
  }
  if (brief.recent.length > 0) {
    lines.push(
      "",
      "Recent sentences (do not repeat or trivially reword):",
      ...brief.recent.map(
        (example) => `- ${example.finnish} — ${example.english}`,
      ),
    );
  }
  const recent = new Set(brief.recent.map((example) => example.finnish));
  const earlier = brief.earlier.filter(
    (example) => !recent.has(example.finnish),
  );
  if (earlier.length > 0) {
    lines.push(
      "",
      "Earlier sentences for this target (already used; never repeat them):",
      ...earlier.map((example) => `- ${example.finnish}`),
    );
  }
  lines.push("", `Write ${brief.candidates} new sentences.`);
  return lines.join("\n");
};

type Written = (typeof Drafts.Type.sentences)[number];

const renderReviewBrief = (
  brief: CurriculumBrief,
  drafts: ReadonlyArray<Written>,
): string =>
  [
    ...renderContext(brief),
    "",
    "Sentences:",
    ...drafts.map(
      (draft, index) =>
        `${index}. Finnish: ${draft.finnish}\n   English: ${draft.english}\n   Content words: ${draft.contentWords.join(", ")}\n   Realisation: ${draft.realisation}`,
    ),
  ].join("\n");

const passes = (verdict: Verdict) =>
  verdict.grammatical &&
  verdict.natural &&
  verdict.translationAccurate &&
  verdict.standalone &&
  verdict.targetPresent &&
  verdict.onlyAllowedConstructions &&
  verdict.vocabularyGrounded &&
  verdict.registerConsistent;

/** Why a draft fails the checks that need no model, if it does. */
const deterministicProblem = (
  draft: Written,
  brief: CurriculumBrief,
  taken: Set<string>,
): string | undefined => {
  if (draft.finnish === "" || draft.english === "") {
    return "empty sentence or translation";
  }
  if (normalizeSentence(draft.finnish) === normalizeSentence(draft.english)) {
    return "translation repeats the Finnish";
  }
  const normalized = normalizeSentence(draft.finnish);
  if (taken.has(normalized)) {
    return "duplicate of an earlier sentence";
  }
  const key = contentKey(draft.contentWords);
  if (key === "") {
    return "no content words";
  }
  if (brief.avoidContent.includes(key)) {
    return `reuses content combination ${key}`;
  }
  if (realisationOf(draft.realisation, brief.target) === undefined) {
    return `unknown realisation "${draft.realisation}"`;
  }
  taken.add(normalized);
  return undefined;
};

/** Form text without case, spacing or parenthetical remarks such as "(inessive)". */
const formKey = (form: string) =>
  form
    .replaceAll(/\([^)]*\)/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * The target's form a draft claims to use. Writers often drop remarks or
 * change case when copying a form, which should not cost a good sentence.
 */
export const realisationOf = (
  claimed: string,
  target: LearningTarget,
): string | undefined =>
  target.realisations.find(
    (realisation) => formKey(realisation.form) === formKey(claimed),
  )?.form;

export const llmCurriculumAuthorLayer = Layer.effect(
  CurriculumAuthor,
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;

    const authoringError =
      (operation: string) =>
      (error: AiError.AiError): AuthoringError =>
        new AuthoringError({ cause: error, message: error.message, operation });

    const logRejections = (
      rejected: ReadonlyArray<RejectedDraft>,
      brief: CurriculumBrief,
    ) =>
      rejected.length === 0
        ? Effect.void
        : Effect.logInfo("Discarded curriculum sentences").pipe(
            Effect.annotateLogs({
              rejected,
              role: brief.plan.role,
              targetId: brief.target.id,
            }),
          );

    const review = Effect.fn("CurriculumAuthor.review")(function* (
      brief: CurriculumBrief,
      drafts: ReadonlyArray<Written>,
    ) {
      const response = yield* model
        .generateObject({
          objectName: "curriculum_review",
          prompt: [
            { content: REVIEW_INSTRUCTIONS, role: "system" },
            { content: renderReviewBrief(brief, drafts), role: "user" },
          ],
          schema: Review,
        })
        .pipe(retryAiCall("CurriculumAuthor.review"));
      const verdicts = new Map<number, Verdict>();
      for (const verdict of response.value.verdicts) {
        verdicts.set(verdict.index, verdict);
      }
      return verdicts;
    });

    const write = Effect.fn("CurriculumAuthor.write")(
      function* (brief: CurriculumBrief) {
        const response = yield* model
          .generateObject({
            objectName: "curriculum_sentences",
            prompt: [
              { content: WRITER_INSTRUCTIONS, role: "system" },
              { content: renderWriterBrief(brief), role: "user" },
            ],
            schema: Drafts,
          })
          .pipe(retryAiCall("CurriculumAuthor.write"));
        const rejected: Array<RejectedDraft> = [];
        const taken = new Set(
          [...brief.recent, ...brief.earlier].map((example) =>
            normalizeSentence(example.finnish),
          ),
        );
        const candidates = response.value.sentences
          .map((draft): Written => ({
            contentWords: draft.contentWords
              .map((word) => word.trim())
              .filter((word) => word !== ""),
            english: draft.english.trim(),
            finnish: draft.finnish.trim(),
            realisation: draft.realisation.trim(),
          }))
          .filter((draft) => {
            const problem = deterministicProblem(draft, brief, taken);
            if (problem !== undefined) {
              rejected.push({ finnish: draft.finnish, reason: problem });
            }
            return problem === undefined;
          });
        if (candidates.length === 0) {
          yield* logRejections(rejected, brief);
          return { accepted: [], rejected };
        }
        const verdicts = yield* review(brief, candidates);
        const accepted: Array<CurriculumDraft> = [];
        for (const [index, draft] of candidates.entries()) {
          const verdict = verdicts.get(index);
          if (verdict === undefined || !passes(verdict)) {
            rejected.push({
              finnish: draft.finnish,
              reason: verdict?.note ?? "no verdict",
            });
          } else {
            accepted.push({
              ...draft,
              realisation:
                realisationOf(draft.realisation, brief.target) ??
                draft.realisation,
              reviewNote: verdict.note.trim(),
            });
          }
        }
        yield* logRejections(rejected, brief);
        return {
          accepted: accepted.slice(0, Math.max(0, brief.candidates)),
          rejected,
        };
      },
      Effect.mapError(authoringError("CurriculumAuthor.write")),
    );

    return CurriculumAuthor.of({ write });
  }),
);

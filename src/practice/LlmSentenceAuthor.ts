import { Effect, Layer, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { AiError } from "effect/unstable/ai";

import { retryAiCall } from "../ai/retryAiCall.ts";
import { SessionProfile } from "../domain/model.ts";
import type { SentenceId, Transcript } from "../domain/model.ts";
import { AuthoringError, SentenceAuthor } from "./SentenceAuthor.ts";
import type { SentenceBrief, SentenceDraft } from "./SentenceAuthor.ts";

const Drafts = Schema.Struct({
  sentences: Schema.Array(
    Schema.Struct({
      english: Schema.String,
      finnish: Schema.String,
      /** Id of the struggle this simplifies, or null. */
      variationOf: Schema.NullOr(Schema.String),
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
      standalone: Schema.Boolean,
      translationAccurate: Schema.Boolean,
    }),
  ),
});

const PROFILE_SYSTEM = `You are an expert Finnish teacher helping a native English speaker learn Finnish through "crosstalk": a native Finnish speaker talks only in Finnish (illustrating with sketches), while the learner answers only in English.

You receive an automatic speech-recognition transcript of one crosstalk session. It mixes Finnish and English, speaker labels may be missing or wrong, and recognition errors are likely. Turns marked "unclear" were doubtful to the transcriber. The learner's English replies show what they followed ("I don't understand" and similar) and help you translate.

Build a profile of the Finnish the learner was exposed to:
- utterances: Finnish sentences or phrases from the transcript that are clearly and plausibly transcribed, lightly cleaned of disfluencies (keep colloquial forms as spoken). Give each an English translation, using the English replies as context. Skip anything garbled, implausible, fragmentary beyond use, or of doubtful transcription, and count those skips in discardedSnippets. Never invent Finnish that was not said.
- vocabulary: the Finnish words used, with the form(s) heard, the dictionary lemma and an English gloss. Include function words only when notable.
- constructions: grammatical patterns that recur or matter (cases, verb forms, question patterns, colloquial constructions), each with a short Finnish example from the session.
- register: how the Finnish speaker talked (spoken vs. standard forms such as "mä/sä" vs. "minä/sinä", pace, formality).
- topics and summary: what the conversation was about, in English.`;

const WRITER_SYSTEM = `You write Finnish listening-comprehension practice for a native English speaker. The learner will only hear each sentence (no text), then judge whether they understood it; the English translation is shown only on request.

Write new sentences grounded in a session profile from the learner's own conversation with a native speaker:
- Build sentences mostly from the profile's vocabulary and constructions, recombined in new ways. An occasional new word is fine if it fits the topics and is guessable from context, but stay close to what was heard.
- Match the speaker's register (e.g. keep spoken forms if they used them) while keeping sentences clear, complete and natural.
- Every sentence must make sense on its own, without the drawings or the rest of the conversation.
- Vary structure and content. Do not repeat or trivially reword the recent sentences; swapping a single word is not a new sentence.
- Keep most sentences between 4 and 14 words.
- When struggles are listed, make roughly half of the sentences simpler variations of them (shorter, more familiar words, the same key vocabulary or structure, but a genuinely different sentence) and set variationOf to the struggle's id. Otherwise set variationOf to null.
- Give an accurate, natural English translation for each sentence.`;

const REVIEW_SYSTEM = `You are a meticulous native Finnish editor reviewing sentences written for a language learner who will hear them spoken aloud without text. Colloquial spoken Finnish is acceptable when it is natural.

For each numbered sentence, judge:
- grammatical: correct Finnish (standard or natural spoken forms).
- natural: something a native speaker would plausibly say.
- translationAccurate: the English translation faithfully conveys the Finnish.
- standalone: understandable without any surrounding context.
Be strict: when in doubt, mark false and explain briefly in note.`;

const renderTranscript = (transcript: Transcript): string =>
  transcript.turns
    .map((turn) => {
      const labels = [
        turn.speaker ?? "?",
        ...(turn.language === undefined ? [] : [turn.language]),
        ...(turn.clear === false ? ["unclear"] : []),
      ];
      return `[${labels.join(", ")}] ${turn.text}`;
    })
    .join("\n");

const renderBrief = (brief: SentenceBrief): string => {
  const { profile } = brief;
  const lines = [
    `Session summary: ${profile.summary}`,
    `Topics: ${profile.topics.join(", ")}`,
    `Register: ${profile.register}`,
    "",
    "Vocabulary (heard form | lemma | English):",
    ...profile.vocabulary.map(
      (item) => `- ${item.heard} | ${item.lemma} | ${item.english}`,
    ),
    "",
    "Constructions:",
    ...profile.constructions.map(
      (item) => `- ${item.description} (e.g. "${item.example}")`,
    ),
    "",
    "Finnish heard in the session:",
    ...profile.utterances.map((item) => `- ${item.finnish} — ${item.english}`),
  ];
  if (brief.recent.length > 0) {
    lines.push(
      "",
      "Recent sentences (do not repeat or trivially reword):",
      ...brief.recent.map((sentence) => `- ${sentence}`),
    );
  }
  if (brief.struggles.length > 0) {
    lines.push(
      "",
      "Struggles (the learner did not understand these):",
      ...brief.struggles.map(
        (struggle) =>
          `- id ${struggle.sentenceId}: ${struggle.finnish} — ${struggle.english}`,
      ),
    );
  }
  lines.push("", `Write ${brief.count} new sentences.`);
  return lines.join("\n");
};

export const llmSentenceAuthorLayer = Layer.effect(
  SentenceAuthor,
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;

    const authoringError =
      (operation: string) =>
      (error: AiError.AiError): AuthoringError =>
        new AuthoringError({ cause: error, message: error.message, operation });

    const profileSession = Effect.fn("SentenceAuthor.profileSession")(
      function* (transcript: Transcript) {
        const response = yield* model
          .generateObject({
            objectName: "session_profile",
            prompt: [
              { content: PROFILE_SYSTEM, role: "system" },
              {
                content: `Transcript:\n${renderTranscript(transcript)}`,
                role: "user",
              },
            ],
            schema: SessionProfile,
          })
          .pipe(retryAiCall("SentenceAuthor.profileSession"));
        return response.value;
      },
      Effect.mapError(authoringError("SentenceAuthor.profileSession")),
    );

    const review = Effect.fn("SentenceAuthor.review")(function* (
      drafts: ReadonlyArray<{ finnish: string; english: string }>,
    ) {
      const response = yield* model
        .generateObject({
          objectName: "sentence_review",
          prompt: [
            { content: REVIEW_SYSTEM, role: "system" },
            {
              content: drafts
                .map(
                  (draft, index) =>
                    `${index}. Finnish: ${draft.finnish}\n   English: ${draft.english}`,
                )
                .join("\n"),
              role: "user",
            },
          ],
          schema: Review,
        })
        .pipe(retryAiCall("SentenceAuthor.review"));
      const accepted = new Set(
        response.value.verdicts
          .filter(
            (verdict) =>
              verdict.grammatical &&
              verdict.natural &&
              verdict.translationAccurate &&
              verdict.standalone,
          )
          .map((verdict) => verdict.index),
      );
      const rejected = response.value.verdicts.filter(
        (verdict) => !accepted.has(verdict.index),
      );
      if (rejected.length > 0) {
        yield* Effect.logInfo("Discarded questionable sentences").pipe(
          Effect.annotateLogs({
            rejected: rejected.map((verdict) => ({
              note: verdict.note,
              sentence: drafts[verdict.index]?.finnish,
            })),
          }),
        );
      }
      return accepted;
    });

    const writeSentences = Effect.fn("SentenceAuthor.writeSentences")(
      function* (brief: SentenceBrief) {
        const response = yield* model
          .generateObject({
            objectName: "practice_sentences",
            prompt: [
              { content: WRITER_SYSTEM, role: "system" },
              { content: renderBrief(brief), role: "user" },
            ],
            schema: Drafts,
          })
          .pipe(retryAiCall("SentenceAuthor.writeSentences"));
        const drafts = response.value.sentences.filter(
          (draft) => draft.finnish.trim() !== "" && draft.english.trim() !== "",
        );
        if (drafts.length === 0) {
          return [];
        }
        const accepted = yield* review(drafts);
        const struggleIds = new Map<string, SentenceId>(
          brief.struggles.map((struggle) => [
            struggle.sentenceId,
            struggle.sentenceId,
          ]),
        );
        return drafts
          .filter((_, index) => accepted.has(index))
          .map((draft): SentenceDraft => ({
            english: draft.english.trim(),
            finnish: draft.finnish.trim(),
            // Only ids we actually offered count as variations.
            variationOf:
              draft.variationOf === null
                ? null
                : (struggleIds.get(draft.variationOf) ?? null),
          }));
      },
      Effect.mapError(authoringError("SentenceAuthor.writeSentences")),
    );

    return SentenceAuthor.of({ profileSession, writeSentences });
  }),
);

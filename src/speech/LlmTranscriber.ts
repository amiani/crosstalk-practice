import { Config, Effect, FileSystem, Layer, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";

import { retryAiCall } from "../ai/retryAiCall.ts";
import { RecordingConverter } from "../audio/RecordingConverter.ts";
import type { TranscriptTurn } from "../domain/model.ts";
import { Transcriber, TranscriptionError } from "./Transcriber.ts";
import type { Recording } from "./Transcriber.ts";

const Heard = Schema.Struct({
  turns: Schema.Array(
    Schema.Struct({
      clear: Schema.Boolean,
      language: Schema.Literals(["fi", "en", "other"]),
      speaker: Schema.Literals(["native_speaker", "learner", "unknown"]),
      text: Schema.String,
    }),
  ),
});

const INSTRUCTIONS = `Transcribe this audio verbatim. It is part of a "crosstalk" language session: a native Finnish speaker talks only in Finnish, and the learner answers only in English.

- Write every word in every language, in order, as one entry per speaker turn.
- speaker: native_speaker for the Finnish speaker, learner for the English speaker, unknown if you cannot tell.
- language: the language of the turn (fi, en, or other).
- Keep Finnish exactly as spoken, including colloquial forms (mä, sä, oon, mut). Never translate, correct or tidy up.
- clear: false when you are not confident what was said; still give your best guess.
- Leave out filler sounds only (um, uh).`;

export interface LlmTranscriberOptions {
  /** Pieces keep each request and its output comfortably small. */
  readonly chunkSeconds: number;
  readonly concurrency: number;
  readonly source: string;
}

/**
 * Speech-to-text by a multimodal language model. Unlike dedicated STT
 * models, which tend to lock onto one language, this keeps both halves of a
 * code-switched conversation and labels who said what.
 */
export const llmTranscriberLayer = (options: LlmTranscriberOptions) =>
  Layer.effect(
    Transcriber,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      const converter = yield* RecordingConverter;
      const fs = yield* FileSystem.FileSystem;

      const transcribePart = Effect.fn("LlmTranscriber.transcribePart")(
        function* (path: string) {
          const audio = yield* fs.readFile(path);
          // One flaky piece must not throw away the others' paid work.
          const response = yield* model
            .generateObject({
              objectName: "transcript",
              prompt: [
                {
                  content: [
                    { text: INSTRUCTIONS, type: "text" },
                    { data: audio, mediaType: "audio/mp3", type: "file" },
                  ],
                  role: "user",
                },
              ],
              schema: Heard,
            })
            .pipe(retryAiCall("LlmTranscriber.transcribePart"));
          return response.value.turns;
        },
      );

      const transcribe = Effect.fn("LlmTranscriber.transcribe")(
        function* (recording: Recording) {
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "crosstalk-transcribe-",
          });
          const parts = yield* converter.split(
            recording.path,
            directory,
            options.chunkSeconds,
          );
          const heard = yield* Effect.forEach(parts, transcribePart, {
            concurrency: options.concurrency,
          });
          const turns = heard
            .flat()
            .filter((turn) => turn.text.trim() !== "")
            .map((turn): TranscriptTurn => ({
              clear: turn.clear,
              language: turn.language,
              speaker: turn.speaker,
              text: turn.text.trim(),
            }));
          if (turns.length === 0) {
            return yield* new TranscriptionError({
              message: "The transcription came back empty",
            });
          }
          return {
            source: options.source,
            text: turns.map((turn) => turn.text).join("\n"),
            turns,
          };
        },
        Effect.scoped,
        Effect.mapError((error) =>
          error._tag === "TranscriptionError"
            ? error
            : new TranscriptionError({ cause: error, message: error.message }),
        ),
      );

      return Transcriber.of({ transcribe });
    }),
  );

export const llmTranscriberConfig = Effect.gen(function* () {
  return {
    chunkSeconds: yield* Config.Int("TRANSCRIBE_CHUNK_SECONDS").pipe(
      Config.withDefault(180),
    ),
    concurrency: 3,
  };
});

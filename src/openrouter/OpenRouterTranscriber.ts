import { Config, Effect, FileSystem, Layer } from "effect";

import { RecordingConverter } from "../audio/RecordingConverter.ts";
import { Transcriber, TranscriptionError } from "../speech/Transcriber.ts";
import type { Recording } from "../speech/Transcriber.ts";
import { OpenRouterAudio } from "./OpenRouterAudio.ts";

export interface OpenRouterTranscriberOptions {
  readonly model: string;
  /**
   * Upstream providers time out after about a minute per request, so long
   * recordings are transcribed in pieces of this length.
   */
  readonly chunkSeconds: number;
  readonly concurrency: number;
}

/**
 * Speech-to-text through OpenRouter's transcription endpoint. Each piece
 * becomes one unattributed transcript turn. Diarization is left off: with
 * Gemini Transcribe it suppressed the English entirely. Even without it,
 * Gemini Transcribe dropped the learner's English from a real session,
 * which is why the multimodal-model transcriber is the default.
 */
export const openRouterTranscriberLayer = (
  options: OpenRouterTranscriberOptions,
) =>
  Layer.effect(
    Transcriber,
    Effect.gen(function* () {
      const audio = yield* OpenRouterAudio;
      const converter = yield* RecordingConverter;
      const fs = yield* FileSystem.FileSystem;

      const transcribe = Effect.fn("OpenRouterTranscriber.transcribe")(
        function* (recording: Recording) {
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "crosstalk-transcribe-",
          });
          const parts = yield* converter.split(
            recording.path,
            directory,
            options.chunkSeconds,
          );
          const texts = yield* Effect.forEach(
            parts,
            (part) =>
              fs.readFile(part).pipe(
                Effect.flatMap((bytes) =>
                  audio.transcribe({
                    audio: bytes,
                    format: "mp3",
                    model: options.model,
                  }),
                ),
              ),
            { concurrency: options.concurrency },
          );
          const turns = texts
            .map((text) => text.trim())
            .filter((text) => text !== "")
            .map((text) => ({ speaker: null, text }));
          if (turns.length === 0) {
            return yield* new TranscriptionError({
              message: "The transcription came back empty",
            });
          }
          return {
            source: options.model,
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

export const openRouterTranscriberLive = Layer.unwrap(
  Effect.gen(function* () {
    return openRouterTranscriberLayer({
      chunkSeconds: yield* Config.Int("TRANSCRIBE_CHUNK_SECONDS").pipe(
        Config.withDefault(180),
      ),
      concurrency: 3,
      model: yield* Config.String("TRANSCRIBE_MODEL").pipe(
        Config.withDefault("google/gemini-3.5-transcribe"),
      ),
    });
  }),
);

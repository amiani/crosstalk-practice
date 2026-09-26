import { Config, Effect, Layer } from "effect";

import { pcmFormatFromContentType, pcmToWav } from "../audio/wav.ts";
import {
  SpeechSynthesisError,
  SpeechSynthesizer,
} from "../speech/SpeechSynthesizer.ts";
import { OpenRouterAudio } from "./OpenRouterAudio.ts";

export interface OpenRouterSpeechOptions {
  readonly model: string;
  readonly voice: string;
  /** Delivery direction for Gemini TTS; never spoken aloud. */
  readonly style: string;
}

/** Gemini TTS through OpenRouter returns 24 kHz mono 16-bit PCM by default. */
const GEMINI_PCM = { bitsPerSample: 16, channels: 1, sampleRate: 24000 };

/**
 * Text-to-speech through OpenRouter. Gemini TTS only returns raw PCM there,
 * so the audio is wrapped as WAV for the browser.
 */
export const openRouterSpeechSynthesizerLayer = (
  options: OpenRouterSpeechOptions,
) =>
  Layer.effect(
    SpeechSynthesizer,
    Effect.gen(function* () {
      const audio = yield* OpenRouterAudio;

      const synthesize = Effect.fn("OpenRouterSpeechSynthesizer.synthesize")(
        function* (finnish: string) {
          const speech = yield* audio.speech({
            input: finnish,
            model: options.model,
            providerOptions: {
              "google-ai-studio": {
                speech_metadata: { style: options.style },
              },
            },
            responseFormat: "pcm",
            voice: options.voice,
          });
          if (speech.bytes.byteLength === 0) {
            return yield* new SpeechSynthesisError({
              message: "The speech response contained no audio",
            });
          }
          return {
            bytes: pcmToWav(
              speech.bytes,
              pcmFormatFromContentType(speech.contentType, GEMINI_PCM),
            ),
            mimeType: "audio/wav",
          };
        },
        Effect.mapError((error) =>
          error._tag === "SpeechSynthesisError"
            ? error
            : new SpeechSynthesisError({
                cause: error,
                message: error.message,
              }),
        ),
      );

      return SpeechSynthesizer.of({ synthesize });
    }),
  );

export const openRouterSpeechSynthesizerLive = Layer.unwrap(
  Effect.gen(function* () {
    return openRouterSpeechSynthesizerLayer({
      model: yield* Config.String("OPENROUTER_TTS_MODEL").pipe(
        Config.withDefault("google/gemini-3.8-flash-tts"),
      ),
      style:
        "A friendly native Finnish speaker talking naturally in a relaxed conversation, clear and unhurried.",
      voice: yield* Config.String("TTS_VOICE").pipe(Config.withDefault("Kore")),
    });
  }),
);

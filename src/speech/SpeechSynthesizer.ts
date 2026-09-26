import { Context, Schema } from "effect";
import type { Effect } from "effect";

export interface SynthesizedSpeech {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export class SpeechSynthesisError extends Schema.TaggedError<SpeechSynthesisError>()(
  "SpeechSynthesisError",
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

/** Text-to-speech for one Finnish sentence. */
export class SpeechSynthesizer extends Context.Service<
  SpeechSynthesizer,
  {
    readonly synthesize: (
      finnish: string,
    ) => Effect.Effect<SynthesizedSpeech, SpeechSynthesisError>;
  }
>()("crosstalk-practice/speech/SpeechSynthesizer") {}

import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { Transcript } from "../domain/model.ts";

export interface Recording {
  readonly path: string;
  readonly mimeType: string;
  readonly fileName: string;
}

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "TranscriptionError",
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

/** Speech-to-text for a whole mixed-language recording. */
export class Transcriber extends Context.Service<
  Transcriber,
  {
    readonly transcribe: (
      recording: Recording,
    ) => Effect.Effect<Transcript, TranscriptionError>;
  }
>()("crosstalk-practice/speech/Transcriber") {}

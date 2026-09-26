import {
  Config,
  Context,
  Effect,
  Encoding,
  Layer,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
} from "effect/unstable/http";
import type { HttpClientResponse } from "effect/unstable/http";

/**
 * OpenRouter's audio endpoints (`/audio/transcriptions`, `/audio/speech`),
 * which the Effect AI provider does not cover. Provider-specific options are
 * forwarded under `provider.options`, keyed by provider slug.
 */

export class OpenRouterAudioError extends Schema.TaggedError<OpenRouterAudioError>()(
  "OpenRouterAudioError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

const Transcription = Schema.Struct({ text: Schema.String });

export interface TranscriptionRequest {
  readonly model: string;
  readonly audio: Uint8Array;
  /** Container format, e.g. "mp3". */
  readonly format: string;
  readonly providerOptions?: Record<string, unknown>;
}

export interface SpeechRequest {
  readonly model: string;
  readonly input: string;
  readonly voice: string;
  readonly responseFormat: "mp3" | "pcm";
  readonly providerOptions?: Record<string, unknown>;
}

export interface SpeechAudio {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

export class OpenRouterAudio extends Context.Service<
  OpenRouterAudio,
  {
    readonly transcribe: (
      request: TranscriptionRequest,
    ) => Effect.Effect<string, OpenRouterAudioError>;
    readonly speech: (
      request: SpeechRequest,
    ) => Effect.Effect<SpeechAudio, OpenRouterAudioError>;
  }
>()("crosstalk-practice/openrouter/OpenRouterAudio") {
  public static readonly layer = (options: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly apiUrl: string;
  }) => Layer.effect(OpenRouterAudio, make(options));

  public static readonly layerConfig = Layer.unwrap(
    Effect.gen(function* () {
      return OpenRouterAudio.layer({
        apiKey: yield* Config.Redacted("OPENROUTER_API_KEY"),
        apiUrl: yield* Config.String("OPENROUTER_API_URL").pipe(
          Config.withDefault("https://openrouter.ai/api/v1"),
        ),
      });
    }),
  );
}

const withProvider = (options: Record<string, unknown> | undefined) =>
  options === undefined ? {} : { provider: { options } };

const make = Effect.fnUntraced(function* (options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiUrl: string;
}) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(options.apiUrl),
        HttpClientRequest.bearerToken(Redacted.value(options.apiKey)),
        HttpClientRequest.setHeader("X-Title", "crosstalk-practice"),
      ),
    ),
    // Transport failures, 408, 429 and 5xx: nothing was delivered.
    HttpClient.retryTransient({
      schedule: Schedule.exponential("1 second"),
      times: 3,
    }),
  );

  const failure =
    (operation: string) =>
    (cause: unknown): OpenRouterAudioError =>
      Schema.is(OpenRouterAudioError)(cause)
        ? cause
        : new OpenRouterAudioError({
            cause,
            message: String(cause),
            operation,
          });

  /** Fails with OpenRouter's own explanation on a non-2xx status. */
  const ensureOk =
    (operation: string) => (response: HttpClientResponse.HttpClientResponse) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((body) =>
              Effect.fail(
                new OpenRouterAudioError({
                  message: `HTTP ${response.status}: ${body.slice(0, 1000)}`,
                  operation,
                }),
              ),
            ),
          );

  const post = (operation: string, path: string, body: unknown) =>
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(client.execute),
      Effect.flatMap(ensureOk(operation)),
    );

  const transcribe = Effect.fn("OpenRouterAudio.transcribe")(
    function* (request: TranscriptionRequest) {
      const response = yield* post(
        "OpenRouterAudio.transcribe",
        "/audio/transcriptions",
        {
          input_audio: {
            data: Encoding.encodeBase64(request.audio),
            format: request.format,
          },
          model: request.model,
          ...withProvider(request.providerOptions),
        },
      );
      const body =
        yield* HttpIncomingMessage.schemaBodyJson(Transcription)(response);
      return body.text;
    },
    Effect.mapError(failure("OpenRouterAudio.transcribe")),
  );

  const speech = Effect.fn("OpenRouterAudio.speech")(
    function* (request: SpeechRequest) {
      const response = yield* post("OpenRouterAudio.speech", "/audio/speech", {
        input: request.input,
        model: request.model,
        response_format: request.responseFormat,
        voice: request.voice,
        ...withProvider(request.providerOptions),
      });
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      return { bytes, contentType: response.headers["content-type"] };
    },
    Effect.mapError(failure("OpenRouterAudio.speech")),
  );

  return OpenRouterAudio.of({ speech, transcribe });
});

/* eslint-disable effecttsgo/node-builtin-import -- NodeHttpServer is constructed from a Node http.Server. */
import { createServer } from "node:http";

import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { ffmpegRecordingConverter } from "./audio/RecordingConverter.ts";
import { databaseLive } from "./db/Database.ts";
import { apiRoutes } from "./http/routes.ts";
import { OpenRouterAudio } from "./openrouter/OpenRouterAudio.ts";
import { openRouterSpeechSynthesizerLive } from "./openrouter/OpenRouterSpeechSynthesizer.ts";
import { openRouterTranscriberLive } from "./openrouter/OpenRouterTranscriber.ts";
import { llmSentenceAuthorLayer } from "./practice/LlmSentenceAuthor.ts";
import { Practice } from "./practice/Practice.ts";
import { PracticeSettings } from "./practice/PracticeSettings.ts";
import { practiceStorePostgres } from "./practice/PracticeStorePostgres.ts";
import {
  PracticeWorker,
  practiceWorkerLoop,
} from "./practice/PracticeWorker.ts";
import {
  llmTranscriberConfig,
  llmTranscriberLayer,
} from "./speech/LlmTranscriber.ts";

/**
 * Node's http client: no default response timeout, which matters because a
 * 20-minute transcription holds one request open for minutes.
 */
const httpClient = NodeHttpClient.layerNodeHttp;

const openRouterClient = OpenRouterClient.layerConfig({
  apiKey: Config.Redacted("OPENROUTER_API_KEY"),
  siteTitle: Config.succeed("crosstalk-practice"),
}).pipe(Layer.provide(httpClient));

/**
 * An OpenRouter-backed Effect AI `LanguageModel`. Without strict schemas
 * Gemini answers structured requests in prose; requiring the parameter keeps
 * routing to providers that honour it.
 */
const openRouterModel = (model: string) =>
  OpenRouterLanguageModel.layer({
    config: {
      provider: { require_parameters: true },
      strictJsonSchema: true,
    },
    model,
  }).pipe(Layer.provide(openRouterClient));

/**
 * Speech-to-text. The default sends audio to a multimodal model, which keeps
 * both languages of a crosstalk session; `TRANSCRIBER=stt` uses OpenRouter's
 * dedicated transcription endpoint instead (it tends to drop the English).
 */
const transcriberLive = Layer.unwrap(
  Effect.gen(function* () {
    const kind = yield* Config.Literals(
      ["audio-llm", "stt"],
      "TRANSCRIBER",
    ).pipe(Config.withDefault("audio-llm"));
    if (kind === "stt") {
      return openRouterTranscriberLive.pipe(
        Layer.provide(OpenRouterAudio.layerConfig),
      );
    }
    const model = yield* Config.String("TRANSCRIBE_MODEL").pipe(
      Config.withDefault("google/gemini-3.8-flash"),
    );
    const options = yield* llmTranscriberConfig;
    return llmTranscriberLayer({ ...options, source: model }).pipe(
      Layer.provide(openRouterModel(model)),
    );
  }),
);

/** Speech providers: swap these layers to change STT or TTS vendor. */
const speechLive = Layer.mergeAll(
  transcriberLive,
  openRouterSpeechSynthesizerLive.pipe(
    Layer.provide(OpenRouterAudio.layerConfig),
  ),
).pipe(
  Layer.provide(ffmpegRecordingConverter),
  Layer.provide([httpClient, NodeServices.layer]),
);

/** Sentence writing through any Effect AI language model. */
const authorLive = llmSentenceAuthorLayer.pipe(
  Layer.provide(
    Layer.unwrap(
      Config.String("OPENROUTER_MODEL").pipe(
        Config.withDefault("google/gemini-3.8-flash"),
        Config.map(openRouterModel),
      ),
    ),
  ),
);

const workerLive = PracticeWorker.layer.pipe(
  Layer.provide([speechLive, authorLive]),
);

const practiceLive = Practice.layer.pipe(
  Layer.provideMerge(workerLive),
  Layer.provide(
    ffmpegRecordingConverter.pipe(Layer.provide(NodeServices.layer)),
  ),
  Layer.provide(practiceStorePostgres),
  Layer.provide(databaseLive),
  Layer.provide([PracticeSettings.layerConfig, NodeServices.layer]),
);

export const ApplicationLive = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1"),
    );
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(4280));
    const webRoot = yield* Config.String("WEB_ROOT").pipe(
      Config.withDefault("dist/web"),
    );
    yield* Effect.logInfo(
      `crosstalk-practice listening on http://${host}:${port}`,
    );

    const routes = Layer.mergeAll(
      apiRoutes,
      HttpStaticServer.layer({ root: webRoot, spa: true }),
    );
    return Layer.merge(HttpRouter.serve(routes), practiceWorkerLoop).pipe(
      Layer.provide(practiceLive),
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
    );
  }),
);

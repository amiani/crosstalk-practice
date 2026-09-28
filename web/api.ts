/* eslint-disable effecttsgo/async-function, effecttsgo/extends-native-error, effecttsgo/global-fetch, effecttsgo/new-promise -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared API schema and generated client. */
import { Effect, ManagedRuntime, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { Api, presentationEventsPath } from "../src/api/Api.ts";
import {
  PRESENTATION_EVENT_SCHEMA_VERSION,
  PresentationEventBatch,
} from "../src/domain/model.ts";
import type {
  PracticeItem,
  PracticeMode,
  PracticeResponse,
  SentenceId,
  SessionView,
} from "../src/domain/model.ts";
import type { SendEvents } from "./presentationLog.ts";

/** Browser-side access to the JSON API through the generated Effect client. */

const runtime = ManagedRuntime.make(FetchHttpClient.layer);

const makeClient = HttpApiClient.make(Api, {
  baseUrl: window.location.origin,
});

type ApiClient = Effect.Success<typeof makeClient>;

let client: Promise<ApiClient> | undefined;

const call = async <A, E>(
  f: (client: ApiClient) => Effect.Effect<A, E>,
): Promise<A> => {
  client ??= runtime.runPromise(makeClient);
  return runtime.runPromise(f(await client));
};

export const currentSession = async (): Promise<SessionView> =>
  call((c) => c.session.current({}));

export const retrySession = async (): Promise<SessionView> =>
  call((c) => c.session.retry({}));

export const resetSession = async (): Promise<void> =>
  call((c) => c.session.reset({})).then(() => undefined);

/** Selects the mode of sentences after the current one. */
export const setMode = async (mode: PracticeMode): Promise<SessionView> =>
  call((c) => c.session.setMode({ payload: { mode } }));

export const upcoming = async (): Promise<ReadonlyArray<PracticeItem>> =>
  call((c) => c.practice.upcoming({}));

export const respond = async (
  sentenceId: SentenceId,
  payload: PracticeResponse,
): Promise<void> =>
  call((c) => c.practice.respond({ params: { sentenceId }, payload })).then(
    () => undefined,
  );

const encodeBatch = Schema.encodeSync(PresentationEventBatch);

/**
 * Posts presentation events with a plain `fetch` rather than the generated
 * client: `keepalive` lets the request outlive the page, and the status code
 * alone decides whether a batch is worth retrying.
 */
export const sendPresentationEvents: SendEvents = async (
  sentenceId,
  presentationId,
  events,
  { keepalive },
) => {
  let response: Response;
  try {
    response = await fetch(presentationEventsPath(sentenceId, presentationId), {
      body: JSON.stringify(
        encodeBatch({
          events,
          schemaVersion: PRESENTATION_EVENT_SCHEMA_VERSION,
        }),
      ),
      headers: { "content-type": "application/json" },
      keepalive,
      method: "POST",
    });
  } catch {
    return "retry";
  }
  if (response.ok) {
    return "accepted";
  }
  if (response.status === 404) {
    // A deleted sentence is final; any other 404 is most likely a server
    // that predates this endpoint, so keep the events until it is updated.
    const body: unknown = await response.json().catch(() => undefined);
    const gone = Predicate.isObject(body) && body._tag === "SentenceNotFound";
    return gone ? "rejected" : "retry";
  }
  const transient =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500;
  return transient ? "retry" : "rejected";
};

/**
 * A rejected upload, with the HTTP status (409 when a session already exists,
 * 422 when the recording was rejected) and the server's message.
 */
export class UploadError extends Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Uploads a recording as multipart form data. Uses XMLHttpRequest rather than
 * the generated client (which cannot send browser files) so the page can show
 * upload progress for long recordings.
 */
export const uploadRecording = async (
  file: File,
  mode: PracticeMode,
  onProgress: (fraction: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("mode", mode);
    form.append("recording", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/session");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(
        new UploadError(
          xhr.status,
          uploadErrorMessage(xhr.status, xhr.responseText),
        ),
      );
    });
    xhr.addEventListener("error", () =>
      reject(new Error("Upload failed. Is the server running?")),
    );
    xhr.send(form);
  });

const uploadErrorMessage = (status: number, body: string): string => {
  let message: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string" &&
      parsed.message !== ""
    ) {
      message = parsed.message;
    }
  } catch {
    // Not JSON; fall through to a generic message.
  }
  if (status === 409) {
    return message ?? "A session already exists.";
  }
  if (status === 422) {
    return message ?? "The recording was rejected.";
  }
  return message ?? `Upload failed (HTTP ${status}).`;
};

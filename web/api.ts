/* eslint-disable effecttsgo/async-function, effecttsgo/extends-native-error, effecttsgo/new-promise -- The browser client is deliberately plain DOM and promise code; Effect is used only for the shared API schema and generated client. */
import { Effect, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { Api } from "../src/api/Api.ts";
import type {
  PracticeItem,
  PracticeResponse,
  SentenceId,
  SessionView,
} from "../src/domain/model.ts";

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

export const upcoming = async (): Promise<ReadonlyArray<PracticeItem>> =>
  call((c) => c.practice.upcoming({}));

export const respond = async (
  sentenceId: SentenceId,
  payload: PracticeResponse,
): Promise<void> =>
  call((c) => c.practice.respond({ params: { sentenceId }, payload })).then(
    () => undefined,
  );

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
  onProgress: (fraction: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const form = new FormData();
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

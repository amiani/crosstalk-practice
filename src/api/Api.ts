import { Schema } from "effect";
import { Multipart } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import {
  AlreadyAnswered,
  NoActiveSession,
  NotRetryable,
  PracticeItem,
  PracticeResponse,
  RecordingRejected,
  SentenceId,
  SentenceNotFound,
  SessionAlreadyExists,
  SessionView,
} from "../domain/model.ts";

/**
 * The JSON API shared by server and browser. Sentence audio is served by a
 * plain route (`GET /api/sentences/:sentenceId/audio`) because its content type
 * comes from whichever speech synthesizer produced it.
 */
export class SessionApi extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("current", "/", { success: SessionView }),
    /**
     * Multipart form with a single `recording` file field. Browsers should
     * post a `FormData` directly; the generated client cannot send files.
     */
    HttpApiEndpoint.post("upload", "/", {
      error: [SessionAlreadyExists, RecordingRejected],
      payload: Schema.Struct({
        recording: Multipart.SingleFileSchema,
      }).pipe(HttpApiSchema.asMultipart({ maxFileSize: "500 MiB" })),
      success: SessionView,
    }),
    HttpApiEndpoint.post("retry", "/retry", {
      error: [NoActiveSession, NotRetryable],
      success: SessionView,
    }),
    HttpApiEndpoint.delete("reset", "/", {
      success: HttpApiSchema.NoContent,
    }),
  )
  .prefix("/api/session") {}

export class PracticeApi extends HttpApiGroup.make("practice")
  .add(
    /** Ready, unanswered sentences in presentation order (at most 3). */
    HttpApiEndpoint.get("upcoming", "/upcoming", {
      error: NoActiveSession,
      success: Schema.Array(PracticeItem),
    }),
    HttpApiEndpoint.post("respond", "/sentences/:sentenceId/response", {
      error: [SentenceNotFound, AlreadyAnswered],
      params: { sentenceId: SentenceId },
      payload: PracticeResponse,
      success: HttpApiSchema.NoContent,
    }),
  )
  .prefix("/api/practice") {}

export class Api extends HttpApi.make("crosstalk-practice")
  .add(SessionApi)
  .add(PracticeApi) {}

export const audioPath = (sentenceId: string) =>
  `/api/sentences/${sentenceId}/audio`;

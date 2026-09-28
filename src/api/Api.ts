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
  PracticeMode,
  PracticeModeChange,
  PracticeResponse,
  PracticeTrack,
  PracticeTrackChange,
  PresentationConflict,
  PresentationEventBatch,
  PresentationId,
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
     * Multipart form with a `recording` file field, an optional `mode`
     * field ("beginner" or "intermediate"; intermediate when omitted, as
     * older clients expect) and an optional `track` field ("crosstalk" or
     * "curriculum"; crosstalk when omitted). Browsers should post a
     * `FormData` directly; the generated client cannot send files.
     */
    HttpApiEndpoint.post("upload", "/", {
      error: [SessionAlreadyExists, RecordingRejected],
      payload: Schema.Struct({
        mode: Schema.optionalKey(PracticeMode),
        recording: Multipart.SingleFileSchema,
        track: Schema.optionalKey(PracticeTrack),
      }).pipe(HttpApiSchema.asMultipart({ maxFileSize: "500 MiB" })),
      success: SessionView,
    }),
    /** Changes the mode of sentences after the current one. Idempotent. */
    HttpApiEndpoint.put("setMode", "/mode", {
      error: NoActiveSession,
      payload: PracticeModeChange,
      success: SessionView,
    }),
    /** Changes the track of sentences after the current one. Idempotent. */
    HttpApiEndpoint.put("setTrack", "/track", {
      error: NoActiveSession,
      payload: PracticeTrackChange,
      success: SessionView,
    }),
    HttpApiEndpoint.post("retry", "/retry", {
      error: [NoActiveSession, NotRetryable],
      success: SessionView,
    }),
    /**
     * Start over, deleting everything: the recording's session and all
     * curriculum progress.
     */
    HttpApiEndpoint.delete("reset", "/", {
      success: HttpApiSchema.NoContent,
    }),
    /**
     * Replaces the recording but keeps curriculum progress: deletes the
     * session and its sentences, audio and logs, and retains the curriculum
     * evidence derived from them. Idempotent.
     */
    HttpApiEndpoint.delete("replaceRecording", "/recording", {
      success: HttpApiSchema.NoContent,
    }),
  )
  .prefix("/api/session") {}

export class PracticeApi extends HttpApiGroup.make("practice")
  .add(
    /**
     * Ready, unanswered crosstalk sentences of the session's current mode,
     * in presentation order (at most 3).
     */
    HttpApiEndpoint.get("upcoming", "/upcoming", {
      error: NoActiveSession,
      success: Schema.Array(PracticeItem),
    }),
    HttpApiEndpoint.post("respond", "/sentences/:sentenceId/response", {
      error: [SentenceNotFound, AlreadyAnswered, PresentationConflict],
      params: { sentenceId: SentenceId },
      payload: PracticeResponse,
      success: HttpApiSchema.NoContent,
    }),
    /**
     * Appends interaction events for one presentation. Idempotent per event
     * id, and accepted after the response too. The browser posts these with
     * a keepalive `fetch` (see `presentationEventsPath`) so they survive the
     * page being closed.
     */
    HttpApiEndpoint.post(
      "recordPresentationEvents",
      "/sentences/:sentenceId/presentations/:presentationId/events",
      {
        error: [SentenceNotFound, PresentationConflict],
        params: { presentationId: PresentationId, sentenceId: SentenceId },
        payload: PresentationEventBatch,
        success: HttpApiSchema.NoContent,
      },
    ),
  )
  .prefix("/api/practice") {}

/**
 * Curriculum practice. Presentation events use the practice group's route;
 * they update curriculum evidence for curriculum sentences.
 */
export class CurriculumApi extends HttpApiGroup.make("curriculum")
  .add(
    /**
     * Ready, unanswered curriculum sentences still worth teaching, in
     * presentation order (at most 2, so the next one is chosen late).
     */
    HttpApiEndpoint.get("upcoming", "/upcoming", {
      error: NoActiveSession,
      success: Schema.Array(PracticeItem),
    }),
    /**
     * Records the response to a curriculum sentence. Resending an identical
     * response succeeds, so clients can retry until it is stored; a
     * different one fails with AlreadyAnswered.
     */
    HttpApiEndpoint.post("respond", "/sentences/:sentenceId/response", {
      error: [SentenceNotFound, AlreadyAnswered, PresentationConflict],
      params: { sentenceId: SentenceId },
      payload: PracticeResponse,
      success: HttpApiSchema.NoContent,
    }),
  )
  .prefix("/api/curriculum") {}

export class Api extends HttpApi.make("crosstalk-practice")
  .add(SessionApi)
  .add(PracticeApi)
  .add(CurriculumApi) {}

export const audioPath = (sentenceId: string) =>
  `/api/sentences/${sentenceId}/audio`;

export const curriculumResponsePath = (sentenceId: string) =>
  `/api/curriculum/sentences/${sentenceId}/response`;

export const presentationEventsPath = (
  sentenceId: string,
  presentationId: string,
) =>
  `/api/practice/sentences/${sentenceId}/presentations/${presentationId}/events`;

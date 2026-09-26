import { Effect, Schedule } from "effect";
import type { AiError } from "effect/unstable/ai";

/**
 * Model calls fail intermittently in ways a fresh attempt usually fixes:
 * rate limits, provider hiccups, and (notably with Gemini) an empty or
 * malformed structured response. `AiError.isRetryable` classifies these;
 * anything else (bad key, invalid request, policy) fails immediately.
 */
export const retryAiCall =
  (
    operation: string,
    options: {
      readonly times?: number;
      readonly schedule?: Schedule.Schedule<unknown, AiError.AiError>;
    } = {},
  ) =>
  <A, R>(effect: Effect.Effect<A, AiError.AiError, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        error.isRetryable
          ? Effect.logWarning(`${operation} attempt failed`).pipe(
              Effect.annotateLogs({ reason: error.message }),
            )
          : Effect.void,
      ),
      Effect.retry({
        schedule: options.schedule ?? Schedule.exponential("2 seconds"),
        times: options.times ?? 2,
        while: (error) => error.isRetryable,
      }),
    );

import { Config, Context, Effect, Layer } from "effect";

export interface PracticeSettingsShape {
  /** Where uploaded recordings wait until they are transcribed. */
  readonly dataDir: string;
  readonly maxRecordingSeconds: number;
  /** Fewer usable Finnish utterances than this cannot ground practice. */
  readonly minUtterances: number;
  /** Unanswered sentences to keep generated ahead of the learner. */
  readonly bufferSize: number;
  /** Sentences requested from the author per call. */
  readonly batchSize: number;
  /** Recent sentences shown to the author to discourage near-repeats. */
  readonly recentSentences: number;
  /** Failures among this many latest responses steer generation. */
  readonly struggleWindow: number;
  readonly maxStruggles: number;
  readonly synthesisConcurrency: number;
}

export class PracticeSettings extends Context.Service<
  PracticeSettings,
  PracticeSettingsShape
>()("crosstalk-practice/practice/PracticeSettings") {
  public static readonly defaults: PracticeSettingsShape = {
    batchSize: 5,
    bufferSize: 6,
    dataDir: "data",
    maxRecordingSeconds: 30 * 60,
    maxStruggles: 3,
    minUtterances: 5,
    recentSentences: 40,
    struggleWindow: 10,
    synthesisConcurrency: 3,
  };

  public static readonly layerConfig = Layer.effect(
    PracticeSettings,
    Effect.gen(function* () {
      const { defaults } = PracticeSettings;
      const int = (name: string, fallback: number) =>
        Config.Int(name).pipe(Config.withDefault(fallback));
      return PracticeSettings.of({
        ...defaults,
        batchSize: yield* int("PRACTICE_BATCH_SIZE", defaults.batchSize),
        bufferSize: yield* int("PRACTICE_BUFFER_SIZE", defaults.bufferSize),
        dataDir: yield* Config.String("DATA_DIR").pipe(
          Config.withDefault(defaults.dataDir),
        ),
        maxRecordingSeconds: (yield* int("MAX_RECORDING_MINUTES", 30)) * 60,
        minUtterances: yield* int(
          "MIN_USABLE_UTTERANCES",
          defaults.minUtterances,
        ),
      });
    }),
  );
}

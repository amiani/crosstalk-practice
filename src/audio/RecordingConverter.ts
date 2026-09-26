import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class RecordingUnusable extends Schema.TaggedError<RecordingUnusable>()(
  "RecordingUnusable",
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

export interface ConvertedRecording {
  readonly path: string;
  readonly mimeType: string;
  readonly seconds: number;
}

/**
 * Normalizes whatever the learner recorded with (m4a, webm, video, ...) into
 * one compact speech format every transcriber accepts.
 */
export class RecordingConverter extends Context.Service<
  RecordingConverter,
  {
    /** Duration of the audio in a file, if it has any. */
    readonly probe: (path: string) => Effect.Effect<number, RecordingUnusable>;
    /** Writes mono speech-quality audio to `output` (without extension). */
    readonly convert: (
      input: string,
      output: string,
    ) => Effect.Effect<ConvertedRecording, RecordingUnusable>;
    /**
     * Cuts a converted recording into consecutive pieces of at most
     * `seconds` each, written to `directory`, returned in order.
     */
    readonly split: (
      input: string,
      directory: string,
      seconds: number,
    ) => Effect.Effect<ReadonlyArray<string>, RecordingUnusable>;
  }
>()("crosstalk-practice/audio/RecordingConverter") {}

const Probe = Schema.fromJsonString(
  Schema.Struct({
    format: Schema.Struct({ duration: Schema.optional(Schema.String) }),
    streams: Schema.Array(Schema.Struct({ codec_type: Schema.String })),
  }),
);
const decodeProbe = Schema.decodeUnknownEffect(Probe);

/** Implementation backed by the ffprobe and ffmpeg executables. */
export const ffmpegRecordingConverter = Layer.effect(
  RecordingConverter,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const ffmpeg = Effect.fn("RecordingConverter.ffmpeg")(function* (
      args: ReadonlyArray<string>,
    ) {
      const exitCode = yield* spawner
        .exitCode(
          ChildProcess.make("ffmpeg", ["-nostdin", "-v", "error", ...args]),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RecordingUnusable({
                cause,
                message: "Could not run ffmpeg; is it installed?",
              }),
          ),
        );
      if (exitCode !== 0) {
        return yield* new RecordingUnusable({
          message: `ffmpeg could not process the recording (exit ${exitCode})`,
        });
      }
    });

    const probe = Effect.fn("RecordingConverter.probe")(function* (
      path: string,
    ) {
      const output = yield* spawner
        .string(
          ChildProcess.make("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            path,
          ]),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RecordingUnusable({
                cause,
                message: "Could not run ffprobe; is ffmpeg installed?",
              }),
          ),
        );
      const info = yield* decodeProbe(output).pipe(
        Effect.mapError(
          (cause) =>
            new RecordingUnusable({
              cause,
              message: "The file could not be read as audio",
            }),
        ),
      );
      const seconds = Option.fromNullishOr(info.format.duration).pipe(
        Option.map(Number),
        Option.filter(Number.isFinite),
      );
      if (
        !info.streams.some((stream) => stream.codec_type === "audio") ||
        Option.isNone(seconds)
      ) {
        return yield* new RecordingUnusable({
          message: "The file contains no audio",
        });
      }
      return seconds.value;
    });

    const convert = Effect.fn("RecordingConverter.convert")(function* (
      input: string,
      output: string,
    ) {
      const converted = `${output}.mp3`;
      yield* ffmpeg([
        "-y",
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "48k",
        converted,
      ]);
      const seconds = yield* probe(converted);
      return { mimeType: "audio/mp3", path: converted, seconds };
    });

    const split = Effect.fn("RecordingConverter.split")(
      function* (input: string, directory: string, seconds: number) {
        yield* ffmpeg([
          "-i",
          input,
          "-f",
          "segment",
          "-segment_time",
          String(seconds),
          "-reset_timestamps",
          "1",
          "-c",
          "copy",
          path.join(directory, "part-%04d.mp3"),
        ]);
        const parts = yield* fs.readDirectory(directory);
        return parts
          .filter((name) => name.startsWith("part-"))
          .toSorted()
          .map((name) => path.join(directory, name));
      },
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new RecordingUnusable({
            cause,
            message: "Could not read the split recording",
          }),
        ),
      ),
    );

    return RecordingConverter.of({ convert, probe, split });
  }),
);

# crosstalk-practice

Listening practice between crosstalk sessions. Upload a recording of a
Finnish/English crosstalk conversation; the tool transcribes it, profiles the
Finnish you heard, and serves an endless stream of new, standalone Finnish
sentences built from that material, spoken by TTS. You only listen: replay as
often as you like, reveal the English if you need it, then mark
**Understood** or **Didn't understand**. Sentences you didn't understand
steer upcoming generation toward simpler variations; answered sentences are
never deliberately replayed.

The domain language is in [CONTEXT.md](CONTEXT.md) and the key decisions, with
their reasons, are in [docs/adr/](docs/adr/).

Local, single-user prototype. One recording at a time; "Start over" deletes
it and everything generated from it.

## Run

Requirements: Node 24+, pnpm, a running PostgreSQL, and `ffmpeg`/`ffprobe` on
the PATH (recordings are normalized to mono MP3 before transcription).

```sh
pnpm install
createdb crosstalk_practice
cp .env.example .env   # add OPENROUTER_API_KEY
pnpm build             # builds the web client into dist/web
pnpm start             # http://127.0.0.1:4280
```

For development, run `pnpm dev` (server, restarts on change) and
`pnpm dev:web` (Vite on http://localhost:5173, proxying `/api`).

To use it from a phone on the same network, set `HOST=0.0.0.0`. There is no
authentication.

## Verify

```sh
./script/lint
CROSSTALK_TEST_DATABASE_URL=postgres://localhost:5432/crosstalk_practice_test pnpm test
pnpm build
```

The PostgreSQL suite is skipped without `CROSSTALK_TEST_DATABASE_URL` and
**drops and recreates** that database's `public` schema.

## How it works

1. **Upload** (`POST /api/session`, multipart `recording`): the file is probed
   (≤ `MAX_RECORDING_MINUTES`, default 30), converted to mono MP3 under
   `DATA_DIR/recordings`, and a session row is created in stage
   `transcribing`.
2. **Background worker** (`PracticeWorker`) reconciles the stored session on
   every wake-up (upload, retry, answer) and at least every 30 s, so restarts
   resume where they left off:
   - `transcribing` → `Transcriber`: the recording is cut into
     `TRANSCRIBE_CHUNK_SECONDS` pieces and each is sent to a multimodal model
     (`google/gemini-3.8-flash` via OpenRouter), which returns turns labelled
     native speaker/learner, language, and whether it was sure. The
     dedicated `google/gemini-3.5-transcribe` is available with
     `TRANSCRIBER=stt`, but on a real session it dropped all of the
     learner's English. The transcript is stored and the source audio
     deleted. Failures keep the audio and can be retried.
   - `analyzing` → `SentenceAuthor.profileSession` (OpenRouter) builds the
     **session profile**: clearly transcribed Finnish utterances with
     translations, vocabulary, constructions, register and topics. Unclear
     snippets are dropped. Fewer than `MIN_USABLE_UTTERANCES` fails the
     session as `insufficient_material` rather than padding with unrelated
     material.
   - `ready` → keep `PRACTICE_BUFFER_SIZE` unanswered sentences ahead of you.
     `SentenceAuthor.writeSentences` writes a batch from the profile, recent
     sentences (to discourage near-repeats) and recent struggles (failures in
     the last 10 answers). A second LLM pass reviews each sentence
     (grammar, naturalness, translation, standalone sense) and questionable
     ones are discarded. Exact duplicates (ignoring case, punctuation and
     spacing) are rejected by a unique index. `SpeechSynthesizer` (`google/gemini-3.8-flash-tts` via
     OpenRouter, raw PCM wrapped as WAV) voices each sentence; audio is
     stored in PostgreSQL.
3. **Practice**: `GET /api/practice/upcoming` returns the next voiced
   sentences (English translation and audio URL only; the Finnish text never
   reaches the browser). `POST /api/practice/sentences/:id/response` records
   `understood`, `translationRevealed` and `replayCount` and wakes the worker.

Persisted until reset: the session, its transcript and profile, every
generated sentence with its audio, and every response.

### Code map

| Path                                                     | Role                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/domain/model.ts`                                    | Schemas shared by server and browser                                               |
| `src/api/Api.ts`                                         | `HttpApi` definition (the browser uses the generated client)                       |
| `src/http/routes.ts`                                     | Thin handlers plus the raw audio route                                             |
| `src/practice/Practice.ts`                               | Learner-facing operations                                                          |
| `src/practice/PracticeWorker.ts`                         | Preparation and buffer upkeep                                                      |
| `src/practice/PracticeStore*.ts`                         | Persistence interface and PostgreSQL implementation                                |
| `src/practice/SentenceAuthor.ts`, `LlmSentenceAuthor.ts` | Profiling and sentence writing over Effect AI `LanguageModel`                      |
| `src/speech/`                                            | `Transcriber` and `SpeechSynthesizer` interfaces; the multimodal-model transcriber |
| `src/openrouter/`                                        | OpenRouter audio endpoints: transcription and speech adapters                      |
| `src/audio/`                                             | ffprobe/ffmpeg conversion and splitting; PCM → WAV                                 |
| `src/db/Database.ts`                                     | Client and migrations                                                              |
| `src/Application.ts`                                     | Layer wiring; swap providers here                                                  |
| `web/`                                                   | Vanilla TS mobile page                                                             |

To change speech vendors, provide different `Transcriber` /
`SpeechSynthesizer` layers in `src/Application.ts`. To change the LLM, set
`OPENROUTER_MODEL` or provide another Effect AI `LanguageModel` layer.

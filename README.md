# crosstalk-practice

Listening practice between crosstalk sessions. Upload a recording of a
Finnish/English crosstalk conversation; the tool transcribes it, profiles the
Finnish you heard, and serves an endless stream of new, standalone Finnish
sentences built from that material, spoken by TTS. You only listen: replay as
often as you like, reveal the English if you need it, then mark
**Understood** or **Didn't understand**. Sentences you didn't understand
steer upcoming generation toward simpler variations; answered sentences are
never deliberately replayed.

Two practice tracks share that listening screen. **Conversation** (crosstalk
practice) writes sentences from the recording's language, as above.
**Building blocks** (curriculum practice) teaches the grammar and function
words that connect those content words, one small concept at a time, using the
recording's vocabulary: see
[docs/curriculum-listening-plan.md](docs/curriculum-listening-plan.md).

The domain language is in [CONTEXT.md](CONTEXT.md) and the key decisions, with
their reasons, are in [docs/adr/](docs/adr/).

Local, single-user prototype. One recording at a time. "New recording (keep
progress)" deletes the recording and everything generated from it but keeps
Building blocks progress; "Start over" deletes everything.

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

1. **Upload** (`POST /api/session`, multipart `recording` plus optional
   `mode`): the file is probed (≤ `MAX_RECORDING_MINUTES`, default 30),
   converted to mono MP3 under `DATA_DIR/recordings`, and a session row is
   created in stage `transcribing` with the chosen **practice mode**. The page
   offers Beginner by default; API clients that omit `mode` get Intermediate.
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
   - `ready` → keep `PRACTICE_BUFFER_SIZE` unanswered sentences of the
     session's current mode ahead of you.
     `SentenceAuthor.writeSentences` writes a batch from the profile, recent
     sentences (to discourage near-repeats) and recent struggles (failures in
     the last 10 answers). A second LLM pass reviews each sentence
     (grammar, naturalness, translation, standalone sense) and questionable
     ones are discarded. In **Beginner** mode the writer must produce
     single-clause sentences (variations included) and the reviewer also
     rejects any sentence that is not a single clause; **Intermediate** has no
     clause restriction. Exact duplicates (ignoring case, punctuation and
     spacing) are rejected by a unique index. `SpeechSynthesizer` (`google/gemini-3.8-flash-tts` via
     OpenRouter, raw PCM wrapped as WAV) voices each sentence; audio is
     stored in PostgreSQL.
3. **Practice**: `GET /api/practice/upcoming` returns the next voiced
   sentences of the current mode (English translation, mode and audio URL
   only; the Finnish text never reaches the browser).
   `PUT /api/session/mode` (`{"mode": "beginner" | "intermediate"}`) switches
   modes: the sentence on screen stays, later ones come from the new mode.
   Unanswered sentences of the other mode are kept for switching back, and
   work already under way keeps its original mode. Each sentence stores
   `generation_mode` and `generation_policy` (for example
   `beginner-single-clause-v1`; sentences from before modes are
   `intermediate`/`legacy-v0`). `POST /api/practice/sentences/:id/response` records
   `understood`, `translationRevealed` and `replayCount` for the
   presentation it was given in, and wakes the worker.
4. **Presentation log**: while a sentence is on screen the browser records
   playback requests/starts/ends/interruptions/failures, translation reveals,
   visibility changes and the response, each with a sequence number and
   monotonic timing. Events wait in `localStorage` until
   `POST /api/practice/sentences/:id/presentations/:presentationId/events`
   accepts them (idempotent per event id; `keepalive` when the page hides).
   They are stored in `practice_presentations` and
   `practice_presentation_events` and do not influence generation.

5. **Curriculum practice** (track `curriculum`, chosen at upload or with
   `PUT /api/session/track`): once the session is ready the worker keeps
   `CURRICULUM_BUFFER_SIZE` (10) sentences ahead with up to
   `CURRICULUM_CONCURRENCY` (4) writing jobs. Every wake-up (an answer, a
   track switch, the 30 s safety net) and every finished job starts one job
   per missing sentence, counting jobs already under way, without waiting for
   them. For each, the pure policy in
   `src/curriculum/CurriculumPolicy.ts` estimates every learning target from
   curriculum evidence and picks a target and role (teaching, transfer or
   review) from an active set of up to four. Targets follow the older Suomen
   mestari 1 progression without chapter boundaries: later eligible targets
   fill free slots in order, and unassessed background grammar unlocks as
   its targets are established. A target that meets every promotion gate but
   the transfer checks gets a transfer sentence next. The
   plan is stored, `CurriculumAuthor`
   writes and independently reviews the sentence from the catalog
   (`src/curriculum/catalog/pilot.ts`, 28 targets from the older Suomen
   mestari 1 progression, currently unreviewed) and the profile's
   vocabulary, and TTS voices it. `GET /api/curriculum/upcoming` serves at most
   four; after running dry the page waits until three are ready (at most 45 s)
   so one wait buys several sentences.
   `POST /api/curriculum/sentences/:id/response` accepts identical
   resends. Each response creates one evidence row, refined as presentation
   events arrive. `DELETE /api/session/recording` replaces the recording but
   keeps evidence; `DELETE /api/session` deletes everything.

   `GET /api/curriculum/progress?since=<epoch ms>` returns, per curriculum,
   the share of its grammar understood (established targets whole, others
   partly by the promotion gates they meet) and the share from responses
   before `since`; Building blocks shows it as a bar with "+x% today".

   Target status (learning, established, …) is not stored: it is recomputed
   from `curriculum_evidence` on every decision. Each plan snapshots the
   target's estimate at planning time, so the latest status per target is
   roughly:

   ```sql
   SELECT DISTINCT ON (target_id) target_id,
     decision->'estimate'->>'status' AS status, created_at AS as_of
   FROM curriculum_plans WHERE decision->'estimate' IS NOT NULL
   ORDER BY target_id, seq DESC;
   ```

Persisted until reset: the session, its transcript and profile, every
generated sentence with its audio, every response, curriculum plans, and the
presentation log. Curriculum evidence persists until "Start over".

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
| `web/presentationLog.ts`                                 | Presentation events: numbering, timing, durable outbox and retrying delivery       |
| `src/curriculum/`                                        | Curriculum catalog, learner model and scheduler, author, store, orchestration      |
| `web/responseOutbox.ts`                                  | Durable, retrying delivery of curriculum responses                                 |

To change speech vendors, provide different `Transcriber` /
`SpeechSynthesizer` layers in `src/Application.ts`. To change the LLM, set
`OPENROUTER_MODEL` or provide another Effect AI `LanguageModel` layer.

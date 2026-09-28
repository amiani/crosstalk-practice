# Experiment: do sentence embeddings predict personal comprehension?

## Status

| Area                                       | State                                  |
| ------------------------------------------ | -------------------------------------- |
| Presentation-level event logging (§2)      | **Implemented** — see below            |
| Difficulty-adjusted collection pilot (§0)  | Beginner/intermediate modes available  |
| Explicit first-listen judgement (§1)       | Not implemented; deliberately deferred |
| Experiment export before “Start over” (§2) | Not implemented                        |
| Embeddings, predictors, evaluation (§3–§7) | Not started                            |

### Implemented: presentation instrumentation

> **Curriculum track.** Curriculum practice (see
> [curriculum-listening-plan.md](curriculum-listening-plan.md), ADR 0008) is
> adaptive and uses presentation facts to qualify its evidence. Its sentences
> (`practice_sentences.track = 'curriculum'`) are not part of this experiment's
> non-adaptive collection population: exclude or analyse them separately, using
> their stored plan and catalog versions. Crosstalk behaviour below is unchanged.

- **Presentations:** every time a sentence becomes current, the browser creates
  a presentation with a client-generated UUID. A reload creates a new
  presentation for the same sentence; it never creates another response.
  `practice_presentations` records the presentation, its sentence and server
  first-seen time.
- **Event log:** `practice_presentation_events` is append-only, with event ID,
  per-presentation sequence, event type, schema version (`1`), monotonic client
  elapsed time from presentation start, client wall-clock time, server receipt
  time and event detail (`jsonb`, keys stored in snake_case like other JSON
  columns). Event types: `Presented` (autoplay, page visible), `PlayRequested`
  (auto/tap, prior started playbacks), `PlaybackStarted` (audio duration),
  `PlaybackEnded`, `PlaybackPaused` (external pause), `PlaybackInterrupted`
  (replay, answered, left), `PlaybackFailed` (including autoplay blocked),
  `TranslationRevealed`, `VisibilityChanged` and `Responded`. Playback events
  share a playback ID, so requests, actual starts, completion and interruptions
  are distinguishable; replay clicks are not counted as completed listens.
- **Responses:** `practice_responses.presentation_id` links each new response to
  its presentation. A composite foreign key guarantees the presentation belongs
  to the same sentence. Existing responses predate presentations and are
  `NULL`. Final `replay_count` and `translation_revealed` remain unchanged.
- **Delivery:** events persist in `localStorage`, flush one second after
  recording, immediately after a response, and with `keepalive` when the page is
  hidden or unloaded. Retries resend identical event IDs; the server ignores
  exact duplicates and rejects sequence/ID conflicts. Network failures, server
  errors and unknown routes during a server/client version mismatch are retried
  with backoff; deleted sentences and invalid batches are dropped.
- **Plain-HTTP phone support:** UUIDs use `crypto.getRandomValues`, because
  `crypto.randomUUID` is unavailable on insecure LAN pages.
- **Scope preserved:** the log does not influence generation, sentence
  selection or struggles. “Start over” still deletes it with all practice data.
- **Verification:** migrations/API/store integration tests, outbox unit tests,
  typecheck, lint, production build, and a headless Chrome run confirming the
  logged sequence for autoplay, completed playback, translation reveal, replay
  interruption, response and page hiding.

Analysis must derive outcomes from event order rather than treating each event
as a label. For example, an unaided response is one whose presentation has a
`Responded` event with no earlier `TranslationRevealed` and only one started
playback. This is a derived, self-selected subset: it is not equivalent to an
explicit first-listen judgement collected for every sentence.

### Implemented: practice modes for the collection pilot

See [practice-modes-plan.md](practice-modes-plan.md). The learner chooses
**Beginner** (writer and reviewer both require single-clause sentences) or
**Intermediate** (the previous, unrestricted rules) at upload and during
practice; a switch applies after the current sentence. Every sentence stores
its immutable `generation_mode` and `generation_policy`
(`beginner-single-clause-v1`, `intermediate-v1`; earlier sentences are
`intermediate`/`legacy-v0`). Exports must read these per-sentence columns,
never the session's current mode. Mode is a generation lever, not a difficulty
label, and it never uses predictions. The single-clause check is LLM review,
not a grammatical guarantee: spot-check Finnish samples before relying on a
pilot block, and record the switching policy used for each block.

Remaining instrumentation gaps:

- The explicit first-listen question would change the learner's workflow during
  the parallel collection pilot, so it is deferred until the pilot protocol is
  settled.
- TTS voice/model settings are not yet stored per sentence; audio duration is
  captured only when playback starts.
- There is no protected export; export data before using “Start over”.
- The running server must be restarted to apply migration
  `0002_presentation_events` and serve the event endpoint. Reload open pages
  afterward. Responses from pages opened before instrumentation are not linked.

## Goal and scope

Test whether `google/gemini-embedding-2`, accessed through OpenRouter, supports
useful probability predictions and immediate online transfer for this learner's
Finnish listening comprehension. Test the encoder–predictor combination, not a
claim that the encoder covers every Finnish construction.

First iteration: frozen text embeddings, small local predictors, no fine-tuning,
no exhaustive linguistic feature inventory. Improve difficulty coverage during
data collection first; freeze the collection policy before formal evaluation.
Run in offline replay and then shadow mode. Predictions must not influence what
the learner hears during evaluation. Other languages and audio embeddings are
separate experiments.

## 0. Collect informative data before judging the model

The existing history is small and mostly negative: most sentences have been beyond
the learner's level. Use it for pipeline checks and exploratory analysis, not a
credible encoder comparison. More of the same overly difficult material is not
the priority; collect successes as well as struggles across varied sentences.

Start with a collection pilot of 50–100 new presentations across several days.
Generate a mixture of deliberately easier sentences, near-level sentences, and a
smaller challenging portion, grounded in the session profile. Shorter sentences,
familiar vocabulary, and simpler clauses are generation levers, not assumed
ground-truth difficulty labels. Adjust this mixture between pilot blocks based on
actual responses, logging policy versions and intended difficulty bands. Aim for
a useful spread of outcomes, not an artificial exact 50/50 balance.

Review class counts, day/family coverage, missing events, and whether easy
sentences actually produce successes after the pilot. Continue development
collection if needed; postpone the 30-family diagnostic suite until the basic
collection workflow works. The later 100/200-response targets remain provisional,
not evidence that 100 labels can fit 768 weights reliably. Use strong shrinkage,
small tuning budgets, and learning curves to decide whether more data is useful.

Before formal evaluation, freeze the generation/selection policy (including any
predefined adaptation rules), label instructions, and predictor settings. Its
resulting sentence stream is the evaluation population. Do not balance the test
set by discarding responses, oversample positives, or apply class-weighted losses
by default: those can distort the probabilities we want to estimate. Retain all
responses and report class-specific performance alongside aggregate metrics.

## 1. Define the outcome before collecting data

- Historical outcome: the existing `understood` judgement under the current
  replay/translation workflow. This is not a verified first-listen label.
- Prospective primary outcome: ask for an understood/didn't-understand judgement
  after the first playback, before replay or translation. Allow both afterward.
  Store this separately from the existing final judgement; do not reinterpret old
  responses or overwrite them.
- Define the instruction consistently: “Did you understand the meaning without
  translation?” Self-report remains a noisy proxy, not objective comprehension.
- Keep historical and prospective results separate. Historical experiments are
  feasibility/development evidence; prospective first-listen data is the primary
  test. Replays and translation reveals are diagnostics, never predictors of a
  response that has not happened yet.

## 2. Snapshot and audit the data

Export a consistent, read-only join of `practice_sentences` and
`practice_responses`, plus session identifiers. Include sentence ID, Finnish text,
`normalized`, `variation_of`, position, creation/answer times, response, replay
count, and translation-revealed flag. Preserve audio hashes and available speech
configuration for audit; embeddings initially use Finnish text only.

Report counts, date range, class balance, missing fields, duplicate responses,
near-repeats, and variation families. Order responses by `answered_at`, with a
documented deterministic tie-breaker. Unanswered sentences have no labels;
utterances in the uploaded conversation are not comprehension-labelled examples.

The current “Start over” cascades deletion through all practice data. Create an
explicit, user-initiated local experiment export before reset, with clear notice
that this separate export persists until deleted. Do not silently change reset
semantics or commit personal data, audio, embeddings, or API credentials.

### Presentation-level event logging

The app already stores final replay counts and translation-revealed flags. Add an
append-only event stream to preserve order and timing, keyed by a unique
presentation ID as well as sentence/session IDs. A sentence may have multiple
presentations after reload or revisit; that must not create independent duplicate
training labels for the same response.

Record presentation opened, playback requested/started/ended/failed, replay
clicked, translation revealed, first-listen response, final response, and
page visibility changes. Include unique event ID, presentation-local sequence,
client elapsed time from a monotonic clock, server receipt time, playback ID,
audio position where relevant, and event-schema version. Deduplicate retries and
preserve client order despite batched/offline delivery. Do not equate a replay
click with successful playback or a missing event with zero replays.

Derive actual completed listens, replay counts, translation timing, and time from
audio end to response. Flag interruptions, hidden-tab periods, reloads, and
incomplete traces; response latency is not a pure measure of comprehension.
Record audio duration and available voice/rate settings before playback. Keep
the initial response immutable when a later supported response is recorded.

For the primary pre-listening model, only sentence properties and previous
presentations' history are eligible features. Current replay/translation/timing
events occur after prediction and must not leak into that model. Later, a
separate explicitly timed model could predict eventual understanding after one
replay, using only events available at that point. Replays and translation use
are auxiliary signals, not automatic negative labels or extra independent
responses. Do not count each event as another labelled training example.

## 3. Verify and cache embeddings

Use `POST https://openrouter.ai/api/v1/embeddings` with bearer authentication and
the exact model ID. First run a tiny paid smoke test, not the full export:

1. Embed two Finnish sentences and a repeated input; check response/input mapping.
2. Request 768 dimensions and float encoding; verify these parameters are accepted
   and the returned dimension is correct. Fail explicitly if unsupported rather
   than silently changing the experiment.
3. Validate finite, nonzero vectors and normalize to unit length locally.
4. Check repeat-input stability within tolerance. Record model/provider metadata
   where available; the model alias is not a guarantee of immutable weights.

Use exact Finnish text, with no translation, response, learner history, or
LLM-generated difficulty explanation appended. Keep preprocessing fixed. Cache by
text hash, model ID, requested dimensions, and preprocessing version. Store raw
vectors and normalization metadata. Use returned indices where provided; never
assume an unordered batch response matches input order.

Bound batch size/concurrency, retry transient failures with backoff, and stop on
authentication/schema errors. Record usage and cost, with a configurable run
budget. All subsequent evaluation must work from cache without network calls.
Precomputing frozen embeddings for future texts is allowed; fitting transforms or
predictors on future labels is not.

OpenRouter currently documents 128–3072 dimensions, recommending 768, 1536, or 3072. Start with 768 to constrain the small-data experiment. Do not sweep dimensions
on the final evaluation set. Text-only use avoids relying on the model page's
inconsistent descriptions of supported audio modalities.

## 4. Compare a small, fixed set of predictors

| ID  | Predictor                                                                                           | Purpose                                                       |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A   | Beta-smoothed cumulative success rate                                                               | No sentence information                                       |
| B   | Recency-weighted success rate                                                                       | Account for changing learner state                            |
| C   | Online regularized logistic regression on log character/word length and prior surface-word exposure | Cheap text baseline; no Finnish parser                        |
| D   | Online regularized logistic regression on normalized embeddings                                     | Primary embedding test                                        |
| E   | Cosine-neighbor, similarity-weighted response average shrunk toward A                               | Alternate test of embedding geometry                          |
| F   | Same predictor as D, with explicit log word and character counts                                    | Primary practical candidate; test incremental value of length |

Predeclare F as the practical candidate, D as its length ablation, and E as
exploratory. Use `log1p` counts with fixed, versioned whitespace-word and Unicode
code-point counting rules. Fit scalar feature scaling on development data only,
then freeze it. Normalize the embedding block separately; do not renormalize the
concatenated vector and accidentally erase length magnitude. Counts are simple
language-agnostic proxies, not a Finnish linguistic analysis. Audio duration is
another pre-presentation candidate, but defer it to a separately declared ablation
rather than expanding the initial tuning search.

All predictors start without evaluation labels and update once per response.
Define prior exposure from earlier presented sentences only. Use a tiny,
predeclared development grid for learning rate, regularization, and neighbor
count/bandwidth/prior strength. Apply comparable tuning budgets and serialize the
chosen settings. For E, use only past neighbours and nonnegative kernel weights.
Do not add a complex hybrid until these comparisons justify it.

For D and F, start with zero weights and a smoothed development-history intercept;
perform one deterministic gradient update per response with L2 regularization.
If no development history exists, initialize the intercept to zero. Document all
numerical choices, including probability clipping for metrics.

## 5. Chronological predict-before-update evaluation

Historical development: use chronological training/validation windows, not random
sentence splits. If reserving a historical holdout, freeze its boundary before
tuning. Audit which variation families cross boundaries and separately report
performance on new families; transfer among related sentences is intentional,
but must not masquerade as generalization to unseen constructions.

Prospective pilot target: 100 first-listen development responses, then 200 locked
evaluation responses across multiple listening days. These are feasibility
targets, not a power guarantee. If either class has fewer than 30 evaluation
responses, or intervals remain broad, mark the result inconclusive and plan a new
collection block without retuning on the evaluated block.

For each event:

1. Obtain every model's probability from state containing earlier responses only.
2. Persist prediction, state/history version, and model configuration.
3. Observe the label and score the prediction.
4. Update every model exactly once and continue.

Hyperparameters stay frozen during evaluation; model weights must continue updating.
Do not normalize, select features, calibrate, or fit dimensionality reduction on
the complete dataset. If later introduced, fit those operations on past data only.

Primary metric: mean log loss. Secondary: Brier score, calibration bins with
counts, learning curves, and per-day/class breakdowns. Accuracy is descriptive
only. Compare paired losses on identical events. Report uncertainty using
day/block bootstrap of paired loss differences, acknowledging that few days and
adaptive practice data limit inference. Report raw sample and cluster counts.

Predeclare a practical target for F: at least 5% relative log-loss reduction versus the
strongest development-selected baseline among A–C, with a paired 95% interval for
the loss difference below zero and no clear Brier-score regression. This is a
pilot decision rule, not a universal scientific threshold.
Report D versus F separately to establish whether explicit length helps; do not
select whichever embedding variant wins on the evaluation set after the fact.

## 6. Controlled contrasts: diagnose what transfers

Prepare approximately 30 natural sentence families, four sentences each, spanning
vocabulary substitution, inflection, clause complexity, spoken/standard forms,
and length. These are evaluation annotations, not a complete feature taxonomy or
inputs to the predictor. Have a competent Finnish speaker review naturalness,
standalone meaning, and the intended contrast. LLM drafting is allowed; LLM
difficulty guesses are not labels.

Include examples sharing a construction across different topics and examples
sharing only a topic. Label these relationships before inspecting embedding
similarities or learner responses. Hold some entire families out of development.
Keep TTS voice/settings fixed, review audio quality, and store audio identity.

Collect actual learner responses in a randomized, logged order with family
members separated to reduce priming. Do not assume the supposedly harder sentence
will be harder for this learner. This set may overlap the prospective collection
above if its membership and schedule are fixed before evaluation.

Report predictions and observed outcomes by contrast; compute pairwise ordering
only for discordant-response pairs and disclose their count. Treat small subgroup
results as exploratory. Plot nearest neighbours for inspection, but do not treat
attractive clusters as proof of comprehension prediction.

## 7. Isolate the effect of one online update

For each eligible response at time t, clone the pre-update model:

- Updated branch receives response t once.
- Control branch omits response t.
- Both branches receive every subsequent intervening response identically.

Compare predict-before-update losses on the next 20 unseen sentences, grouped by
pre-annotated linguistic relationship, topic-only relationship, and unrelated
controls. Restrict this analysis to events with eligible annotated targets; do
not infer relationships from the very embedding being tested. Include A/B to
distinguish useful sentence-specific transfer from a global success-rate shift.

Aggregate paired loss differences with anchor/family dependence acknowledged.
Record immediate before/after predictions on the answered sentence as a numerical
sanity check only—not evaluation evidence. Useful transfer means better future
predictions, not merely a probability changing in the expected direction.

This ablation estimates the value of incorporating feedback into the predictor;
it does not identify how much the learner learned from the sentence.

## 8. Implementation work packages (not implemented yet)

Use TypeScript and the repository's Effect v4 RC dependencies, following
`../effect/LLMS.md`. Keep the experiment outside the production generation loop.

1. `src/experiments/comprehension/`: Schema-defined export/config/prediction formats,
   read-only exporter, manifest, hashes, privacy exclusions.
2. Embedding service using `Context.Service`, `Layer`, Effect `HttpClient`, tagged
   errors, bounded retries, and a filesystem cache. Check the installed AI adapter
   before deciding whether to reuse it or call the embedding endpoint directly.
3. Pure predictor state/update functions, deterministic chronological runner,
   metrics, and machine-readable prediction records.
4. CLI entrypoint for proposed `export`, `embed`, `evaluate`, and `report` commands;
   use `effect/cli` and `NodeRuntime`, not an ad hoc argument parser.
5. Separate opt-in prospective collection mode recording first-listen responses,
   presentation events, experiment order, collection-policy version, and shadow
   predictions before revealing the label. Keep
   normal practice and reset behavior unchanged.
6. Markdown/JSON report with data provenance, costs, configs, exclusions, metrics,
   uncertainty, contrast results, update-transfer results, and limitations.

Execution order: data audit/export and presentation instrumentation first, then
the collection pilot; embedding smoke tests and runner construction can proceed
during collection. Formal comparisons and the full contrast/transfer analysis
wait for adequate data coverage. Do not wait for an embedding model to make the
practice stream easier.

Use `Schema` at external boundaries; reusable effectful operations use `Effect.fn`
or `Effect.fnUntraced`; clocks use Effect time facilities. Read the linked local
HTTP-client, CLI, and testing examples before implementation. Test services with
fake layers; normal automated tests must not call paid APIs.

Required tests: cache correctness, reordered/malformed embedding responses,
dimension mismatch, retry limits, chronological ordering, no future-label access,
exactly-once updates/resume, known metric fixtures, deterministic replay, and an
ablation fixture demonstrating that the branches differ by only one response.
Also test event retry deduplication, out-of-order delivery, interrupted playback,
reload/new-presentation handling, immutable first responses, and the exclusion of
current-presentation telemetry from pre-listening features.
Validate with `./script/lint`, `pnpm test`, and `pnpm build`; database tests must
use the dedicated disposable test database, never the learner's database.

## Decision and deliverables

- **Proceed:** reliable improvement over baselines and evidence of beneficial
  related-sentence transfer; then consider using predictions for generation.
- **Partial success:** prediction improves but local transfer is weak; retain the
  predictor in shadow mode and investigate representation/similarity separately.
- **Inconclusive:** too little label diversity, too few independent days/families,
  or wide uncertainty; collect a new preregistered block.
- **Negative:** no gain over cheap baselines; investigate an alternate predictor,
  representation, or audio information. Do not conclude Finnish is absent from
  the encoder based on one failed probe.

Deliver a reproducible cached run, frozen configuration, per-event predictions,
and an explicit go/no-go/inconclusive report. No outcome establishes coverage of
all Finnish or transfer to other learners/languages. Existing struggle-driven
generation also means historical results apply to that selected practice stream,
not arbitrary Finnish sentences.

## References

- [OpenRouter embedding API](https://openrouter.ai/docs/api/reference/embeddings)
- [Gemini Embedding 2 model page](https://openrouter.ai/google/gemini-embedding-2)
- Repository: `README.md`, `CONTEXT.md`, `src/db/Database.ts`
- Implementation guidance: `../effect/LLMS.md`

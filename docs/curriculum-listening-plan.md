# Adaptive curriculum listening

Status: **milestones 1–6 implemented; milestone 7 (pilot) is under way** with
paid generation against the learner's recording.
Finnish review is pending and **did not block implementation**: content is
marked `unreviewed` and every plan and evidence row records the catalog version,
so evidence gathered before and after review stays distinguishable. See
[As built](#as-built) for where the
implementation deliberately simplifies the design below; the ADR is
[0008](adr/0008-curriculum-track-adapts-to-evidence.md).

## As built

Code: `src/curriculum/` (catalog, policy, evidence derivation, author contract
and LLM adapter, Postgres store, `Curriculum` orchestration), wired through
`PracticeWorker`, `Practice`, `src/api/Api.ts` and `web/`. Migration
`0004_curriculum` runs on the next server start.

Behaviour:

- Tracks: `crosstalk` (unchanged) and `curriculum`, stored per session and per
  sentence. The page calls them **Conversation** and **Building blocks** and
  offers Building blocks first; API clients that omit `track` get crosstalk.
  Curriculum sentences have no practice mode and are excluded from every
  crosstalk query (buffers, recent sentences, struggles, upcoming).
- The worker fills only the selected track. Curriculum keeps 10 sentences ahead
  (`CURRICULUM_BUFFER_SIZE`) with up to 4 writing jobs (`CURRICULUM_CONCURRENCY`):
  a sentence takes 30–150 s to make but about 10 s to answer. Every wake-up
  (answer, switch, 30 s safety net) and every finished job starts one job per
  missing sentence (buffer − unanswered − slots claimed by running jobs), up to
  the limit, without waiting for running jobs; three jobs in a row that store
  nothing stop the chain until the next wake-up. Plans are still chosen one at
  a time, each seeing the plans before it. Each job is one plan → one author
  call (4 drafts; a teaching writing may keep two, the second under a plan of
  its own) → TTS straight away. Pending plans are abandoned only when no job of
  the session runs. Every plan stores target/revision, role,
  family, reason, a decision snapshot (active set, supporting targets,
  background grammar, the target's estimate), model/selection/author/catalog
  versions and the rejected
  drafts with reasons (`rejections`, migration `0005`). A draft's claimed form
  matches a target form ignoring case, spacing and remarks such as "(inessive)".
- Catalog (`suomen-mestari-1-older-v1-unreviewed`): 28 meaning-bearing
  listening targets in the older Suomen mestari 1 order. Chapters are not
  represented: they only fixed the order. Rules that a comprehension response
  cannot isolate (vowel harmony, consonant gradation, word and verb types)
  are never targets. Background grammar is allowed without being assessed,
  once its required targets are established; it replaces the old fixed
  bootstrap scaffold.
- Catalog changes keep evidence for unchanged target IDs and revisions and
  ignore evidence for removed or renamed targets. Since the pilot catalog was
  replaced, evidence from it can therefore establish some targets out of the
  book's order; clear curriculum evidence for a clean start.
- Selection (`curriculum-selection-v4`): up to four active targets, filling
  free slots with the earliest eligible targets. Supporting
  targets are the established ones plus other active targets with at least
  three exposures that are learning and not struggling, so introduced targets
  can be combined long before promotion (the author allows at most one per
  sentence, and a supporting target overrides the primary's exclusions). A
  target whose latest plan among the last four failed is passed over while
  anything else can be chosen. A target meeting every promotion gate but the
  transfer checks gets a transfer sentence next, one unanswered at a time
  (history carries whether each plan's sentence was answered), so the role
  mix cannot hold back promotion.
- Authoring (`curriculum-author-v3`): the writer sees the 12 latest session
  sentences and up to 60 earlier sentences of the target; exact repeats of
  those, repeats within the batch and translations that copy the Finnish are
  dropped before the paid review. Catalog examples are labelled "structure
  only"; up to two very common everyday words beyond the familiar vocabulary
  are always allowed.
- Evidence is read in `evidence_id` order. (A bare `ORDER BY evidence_id`
  under `SELECT evidence_id::text` sorted by the text output column, so
  responses past the tenth were misordered; fixed.)
- Evidence: one `curriculum_evidence` row per curriculum response, created in the
  response transaction and recomputed (`deriveEvidence`) whenever events for
  the sentence arrive, and for all incomplete rows at every worker pass. The
  learner model is rebuilt from all evidence on each decision: no stored
  projection (the data is small), so late events can only change future
  decisions.
- Responses: `POST /api/curriculum/sentences/:id/response` accepts identical
  resends; the browser keeps unsent curriculum answers in a localStorage outbox
  and retries them. Crosstalk responses are unchanged.
- Serving: `GET /api/curriculum/upcoming` returns at most 4 voiced, unanswered
  sentences of the current catalog version whose target is still eligible
  (reviews always are); the page keeps one sentence beyond the current one.
  After running dry it waits until three are ready, or 45 s at most, so one
  wait buys several sentences.
- Status: target status is never stored; it is rebuilt from
  `curriculum_evidence`. Each plan's `decision->'estimate'` snapshots the
  target's estimate when planned (see the README for a query).
- **New recording (keep progress)** (`DELETE /api/session/recording`) deletes the
  session with its sentences, audio, presentations and logs, and keeps evidence
  rows (which snapshot the sentence's Finnish/English and classification).
  **Start over** (`DELETE /api/session`) also deletes all evidence.
- Speech: each sentence stores `speech_source` (TTS model and voice).
- Progress: Building blocks shows, per curriculum, the percentage of its grammar
  understood and today's change (`GET /api/curriculum/progress`,
  `curriculumProgress` in the policy). Established targets count whole; others
  earn up to 90% of their share from independent successes, distinct content
  and separated transfer successes, which never fall, so the figure only drops
  when evidence is reclassified or a target needs revisiting. This relaxes the
  "no concept dashboard" contract below to a single overall figure: individual
  targets are still never shown.

Deliberate simplifications of the design below, to revisit if the pilot needs:

- No server-side claims/leases for serving. The page drops prefetched
  sentences on a track switch; two tabs can be shown the same unanswered
  sentence, and the first response wins as before.
- Replacement keeps an evidence snapshot rather than an archived copy of old
  sentences, audio and event logs; evidence of a replaced recording is frozen
  as it stood.
- Usability of a listen comes from playback only (no playback → not a fair
  listen); hidden-page periods and response latency are recorded but unused.
- Per-register coverage, alternate-content diagnostics for struggling targets,
  and supporting-target exposure counts are not implemented.
- `avoidContent` is sent for transfer and review only; the author enforces it
  deterministically.
- Pilot changes to the design below: the buffer is 10 rather than 3 (writing
  takes far longer than answering); the active set is up to four rather than
  three; introduced (not only established) targets may support others, and a
  failure caused by the supporting construction still counts against the
  primary target.
- Writing jobs are process-local (no durable claims), so only one server
  process should run per database.

Verification: pure policy/evidence tests with simulated learners; fake-model
author tests; PostgreSQL tests for migration backfill, buffering, idempotent
responses, late and cross-presentation events, adaptation after failures,
replace-vs-start-over, track switching, failing generation and the HTTP routes;
browser outbox/queue tests; a headless Chrome smoke test against the test
database (track choice, hidden level control, failed-then-retried answer,
switching after the current sentence, new recording keeping evidence).

## 1. Product contract

Teach Finnish grammar and function concepts through a continuous stream of new
audio sentences. Crosstalk supplies vocabulary, register and interests; a curated
curriculum supplies constructions, including ones absent from the recording.
Preserve the existing crosstalk practice as an independent track.

The learner listens, replays, optionally reveals English, and gives the existing
binary comprehension judgement. No Finnish text, exercises, speaking, placement
test, concept dashboard, lesson boundaries or graduation announcements. Optional
English translation remains: “audio-only” means no Finnish reading requirement,
not removing the existing support. No extra per-sentence questions.

Multiple concepts are taught concurrently. Each sentence isolates one primary
target; established supporting constructions provide the rest. Target isolation
is an authoring constraint, not a promise that comprehension is objectively
measured. The model estimates reported listening comprehension, not knowledge of
Finnish or a calibrated probability of mastery.

### Track, not another difficulty mode

- **Crosstalk practice:** existing Beginner/Intermediate modes, profile-bounded
  generation, recent-struggle variations, unchanged telemetry non-adaptation.
- **Curriculum practice:** its own curriculum, scheduler, learner model and
  authoring policy. Beginner/Intermediate does not constrain this track; later
  targets may require multiple clauses.
- Offer a track selector at upload and during practice, with a short explanation.
  Existing installations and clients default to crosstalk practice. The active
  sentence finishes under its original track; the switch affects the next one.
  Only show the difficulty selector for crosstalk practice.
- Both tracks initially require a usable recording. No generic vocabulary fallback
  or multi-recording corpus in this feature.

## 2. Curriculum: coverage versus progression

Build a source-linked A1-oriented coverage map, not an alleged complete inventory
of Finnish. Extend to A2 only after the initial loop works. Grammar headings are
coverage categories; teachable targets are small meaning/form contrasts.

Initial primary sources:

- Suomen mestari 1, older edition, and its teacher's guide
  (`urn:isbn:978-951-792-438-2`, `urn:isbn:978-951-792-493-1`): the
  catalog's progression. The teacher's guide's per-chapter grammar lists fix
  the order; chapters themselves are not modelled.
- [Suomen mestari 1, revised official contents and samples](https://finnlectura.fi/media/sites/2/suomen-mestari-1-uudistettu-naytesivut-3.pdf):
  checked against the older edition; not used for the catalog order.
- [Publisher description](https://finnlectura.fi/oppimateriaalit/suomi-toisena-kielena/suomen-mestari/uudistettu-suomen-mestari-1/):
  A1 scope and spoken Finnish from the beginning.
- [University of Helsinki course contents](https://www.helsinki.fi/en/language-centre/teaching-and-research/finnish-foreigners/course-materials-objectives-and-contents):
  independent coverage cross-check.
- [Official proficiency descriptions](https://www.oph.fi/sites/default/files/documents/169247_proficiency_levels_cefr.pdf):
  communicative outcomes, not a Finnish grammar inventory or teaching order.

Extract the grammar progression, not textbook exercises, phrases or long
passages: crosstalk provides vocabulary and phrases. Author our own examples.
Only meaning distinctions that a comprehension response can plausibly reflect
become targets. Form rules such as vowel harmony, consonant gradation and word
or verb types are background grammar. Have a competent Finnish teacher review
target granularity, naturalness, prerequisites and register.

### Target definition (versioned, server-side)

Each entry contains a stable ID and revision, meaning, contrast, permitted Finnish
realisations by register, required prerequisites,
exclusions, example/counterexample briefs, variation dimensions, source links,
and linguistic-review status. Define family IDs for structurally similar examples
before observing responses. A target revision changing its meaning needs an
explicit evidence migration; do not silently carry its old estimate forward.

Targets are listed in teaching order. Background grammar entries describe
constructions sentences may use once their required targets are established;
they are never assessed or promoted.

Example: **recognise who possesses an object**. Start with first/second-person
affirmative possession and a consistent register; hold the object familiar.
Negation, questions and additional person forms are separate extensions, not
automatically acquired when this target progresses.

Coverage groups to decompose: identity/participants; reference/demonstratives;
possession; negation; questions; existence/location/direction; quantity and
object-related meaning; time; modality/verb combinations; addition/alternatives;
postpositions; clause relationships and conversational particles where in scope.
An English word is not the unit: Finnish may use an ending or a construction.

### Starting grammar and progression

The catalog follows the older Suomen mestari 1 progression, from participants,
negation and questions through possession, place and direction, plurality,
commands, demonstratives, people as recipients or sources, and subordinate
clauses. It is not a linguistically validated syllabus. Enough early targets
have no prerequisites that the active set starts with variety; a later target
is introduced when earlier ones are active, established or waiting on
prerequisites.

At cold start, only simple affirmative statements with olla are background
grammar. More background grammar, such as verb types and partitive-taking
verbs, becomes available only after the targets it depends on are established.
If early sentences fail, reduce content variation and review assumptions rather
than unlocking harder targets.

Vocabulary heard in a recording is **candidate familiar vocabulary**, not proof
of understanding. Prefer repeatedly heard, clear content words. Vary across
several such words; repeated difficulty with a particular word can trigger an
alternate-content diagnostic sentence without blaming the glue target.

## 3. Selection policy: a small active set

Initial policy constants below are testable engineering defaults, not learning
science claims. Store and version them separately from authoring/model policies.

- Maintain up to **four learning targets**, restricted to eligible prerequisites
  and filled with the earliest eligible targets in catalog order. Fewer is valid
  when the graph or source vocabulary limits eligibility.
- In a rolling ten selections aim for six teaching, two transfer, two review
  sentences. Redistribute unavailable roles to eligible teaching; never fabricate
  readiness or unlock a prerequisite to satisfy a quota.
- Round-robin learning targets by staleness with a small bonus for struggle;
  avoid more than two consecutive selections of the same target. An active
  target waiting five sentences is chosen next, so none can starve.
- Teaching repeats a construction deliberately while changing familiar content.
  Transfer uses a new content combination/family, separated from near-identical
  teaching examples (v1: after three exposures, never twice in a row; the author
  enforces family separation).
- Review revisits established concepts in fresh sentences. First review is due
  after ten other answered curriculum sentences; later reviews also use elapsed
  time (initially next day, then three days). These are opportunities, not deadlines
  requiring the learner to return. Time alone does not create negative evidence.
- Keep topic, person and sentence-shape variety within the permitted inventory.
  Do not require all active targets to occur in one sentence.
- Two recent valid primary-target failures trigger easier examples and an earlier
  revisit, not immediate attribution to every supporting construction. Persistent
  difficulty triggers alternate familiar content or background-grammar checks. Never silently
  widen the grammar allowance just to fill the buffer.
- When a target becomes established, replace its learning slot with an eligible
  target; retain it in review. If none are eligible, keep varied consolidation.

The scheduler is deterministic given history, time and policy (no randomness in v1).
Persist the selection reason, role, permitted inventory, evidence watermark and
policy versions. LLMs realise plans; they do not choose progression or declare
mastery.

## 4. Learner model and evidence

Maintain target states **unintroduced / learning / established / revisit**, with
exposure, supported successes, independent successes, failures, coverage,
last-practised/review times and uncertainty. “Established” only means suitable as
supporting material under this policy; it is reversible and never shown as mastery.

### Evidence classification

| Observation                                                               | Initial interpretation                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Understood, no reveal, complete audible presentation                      | Positive independent evidence; distinguish one listen from replay-supported success |
| Understood after translation                                              | Supported exposure, not independent positive evidence                               |
| Didn't understand after usable playback                                   | Negative sentence evidence, attributed primarily to the designated target           |
| Replays                                                                   | Support/context, not independent failures or extra observations                     |
| Hidden tab, interruptions, audio failure, response before usable playback | Ambiguous; exposure at most, no readiness credit                                    |
| Missing/conflicting telemetry                                             | Unknown, not proof of no replay or no reveal                                        |
| Latency                                                                   | Context for confidence/diagnostics; never “slow = failure”                          |

Use response flags immediately for a conservative provisional classification;
complete traces refine it. Inspect **all presentations of the sentence** before
the response: a reveal before a reload still contaminates an unaided judgement.
Each responded sentence contributes at most one effective observation. Generated,
buffered or merely fetched sentences do not count as exposure.

For an interpretable initial estimate, keep decayed weighted independent-success
and failure counts, with Beta(1,1) smoothing. This is a heuristic support score and
uncertainty summary, not a calibrated mastery posterior (observations correlate).
Example model-v1 weights: clean transfer/review 1; clean teaching 0.5;
replay-supported success 0.5 of its role weight; translation-supported success 0;
usable failure 1; unusable/ambiguous evidence 0. Cap positive contribution from one
family to 1 per listening day. Decay evidence by half after 30 days, toward the
prior rather than toward failure. Keep raw counts separately. All constants are
configuration frozen for the pilot, with fixtures for their exact semantics.

Promotion is initially rule-based, not a threshold on this score: require at least
eight informative observations, six independent successes, three distinct content
combinations, two non-adjacent transfer successes, and no failures among the last
three informative observations. These provisional gates prevent promotion from a
single template or translation-only streak. They do not establish retention;
subsequent spaced review does. Two failures among the latest three informative
review observations move an established target to revisit. Missing evidence never
promotes or demotes. Coverage is tracked separately for required realisations;
success in one register/person does not automatically establish another.

Supporting targets receive exposure but no independent success/failure updates in
v1. This avoids multiplying one judgement into several supposed labels. A future
model may distribute evidence only if evaluation supports that change.

“Use every signal” means retain and evaluate signals, not invent a trustworthy
coefficient for each. Playback/reveal events affect evidence validity now; timing
and other features can later improve a versioned model if prospective prediction
tests show benefit. No embeddings or learned predictor are prerequisites.

### Late delivery, retries and replayability

Response writes and evidence updates cannot assume telemetry arrived first.
The current browser response submission is fire-and-forget, unlike its durable
event outbox. Add a **curriculum response outbox** with a stable idempotency key:
identical retries succeed; conflicting payloads fail explicitly. Persist the
response and dirty marker in one transaction. A `Responded` event without an
authoritative response row is not an accepted response or another label.
Next-selection requests carry the preceding response key and await its committed
state when online; show a recoverable saving/waiting state rather than pretend
adaptation incorporated an unsaved response. Preserve the current crosstalk API's
`AlreadyAnswered` behaviour; use a dedicated curriculum response route.

For curriculum events, canonicalise the first accepted payload for an event ID
and flag conflicting retries. Existing event IDs alone do not verify full payload
equality. Lost outbox entries/storage failures remain incomplete evidence. Wake
reconciliation on both responses and event ingestion, not only response handling.

Create one revisionable evidence record per response. Recompute it when relevant
events arrive, including older presentations; never add another observation.
An evidence revision marks the affected learner projection dirty. Rebuild that
small projection from ordered evidence (server response order plus stable ID),
atomically publishing a new state revision. Changes can alter future selection,
never relabel already played sentences or rewrite their historical decision logs.

Immediate provisional evidence may select easier teaching, but positive promotion
requires a contiguous trace through the response event. Permanently incomplete
traces remain unknown. State the trace-completeness limitation in reports.
Reconciliation is durable and retryable across crashes. Duplicate response/event
delivery must not duplicate evidence; conflicting responses retain existing API
semantics. Evidence histories/model versions support deterministic offline replay.

## 5. Controlled generation and review

A curriculum sentence plan contains one target/revision, role, contrast, allowed
realisations, supporting-target and background-grammar allowlist, source
vocabulary and register, desired
variation dimension, family, and recent examples. Keep instructions bounded.

The author produces Finnish, English and structured annotations. An independent
review pass checks the target is present and meaning-bearing; all supporting
constructions are allowed; vocabulary is grounded; register is consistent;
translation preserves the distinction; and the result is natural and standalone.
Persist verified target/support annotations, lexical forms, review verdicts and
rejection reasons. Reject unknown concept IDs, unreviewed targets and invalid plans
deterministically. LLM grammatical review is not a formal guarantee.

Unlike crosstalk generation, structural near-repetition is desirable. Retain exact
duplicate prevention; require new complete sentences and avoid merely changing a
proper name indefinitely. Transfer/review get stricter family separation. Do not
use the crosstalk word-count lower bound when it forces extra glue into an example.
Never infer understanding from semantic plausibility alone: make the target alter
who/where/when/polarity, without claiming this defeats all noun-based guessing.

Reuse speech synthesis but record model/voice/configuration and audio identity.
Keep settings stable during the pilot. Bounded draft/review retries and cost limits;
on exhaustion, try another eligible plan or show the existing waiting/error state.
No automatic grammar relaxation, generic vocabulary injection or paid retry loop.

## 6. Module seams and storage

Proposed server-side `src/curriculum/` modules:

- `CurriculumCatalog`: loads and validates reviewed versioned content, dependency
  DAG, coverage metadata and realisations. No learner data or network calls.
- `CurriculumPolicy`: pure evidence projection and next-plan selection. Its small
  interface accepts history/state, catalog, policy, time and seed; returns a new
  estimate or sentence plan with reasons. Test behaviour through these interfaces.
- `CurriculumAuthor`: realises and reviews a plan. Separate from `SentenceAuthor`
  so its relaxed profile constraint cannot leak into crosstalk prompts. Fake and
  LLM adapters provide the test seam.
- `CurriculumStore`: transactions for durable plans, evidence revisions, projection
  publication and serving claims. Postgres is authoritative, not worker memory.

Reuse transcription/profile preparation, speech synthesis, presentation logging
and audio controls. Keep orchestration in `PracticeWorker` initially, delegating
curriculum decisions rather than embedding curriculum rules in its loop. Use the
installed Effect version and repository conventions; implementation must consult
the Effect skill/local references rather than copying APIs from this design.

### Additive schema proposal

- Session: selected `practice_track`, default/backfill `crosstalk`.
- Sentences: immutable `practice_track`; existing mode/policy for crosstalk;
  nullable mode for curriculum with track-specific CHECK constraints. Existing
  rows and policy identities remain unchanged. No third PracticeMode literal.
- `curriculum_plans`: target/revision, role/family, source-session ID, permitted
  inventory, versions, evidence watermark, decision reason, lifecycle and seed;
  one-to-one sentence linkage after accepted generation.
- `curriculum_evidence`: one row per curriculum response, classified observation,
  trace completeness, input fingerprint, revision and model version.
- `curriculum_learner_state`: singleton learner identity, state revision, dirty
  watermark and versioned projection (small JSON snapshot is sufficient initially).
- Retain catalog/policy snapshots or immutable content hashes with archived files;
  a current code constant alone cannot explain historical decisions.

Keep concept/evidence/Finnish annotations server-side. Shared browser schemas expose
only track, applicable mode, English, audio and opaque selection metadata. Validate
every external boundary. Migration must audit existing unique indexes and FKs,
especially exact-duplicate scope, before changing them; preserve current crosstalk
deduplication and reject exact curriculum duplicates within the recording too.

### Recording and progress lifetime

Preserve **Start over** as deletion of all practice data, including new curriculum
progress. Do not silently retain progress after this existing destructive action.

Add an explicit **Replace recording, keep curriculum progress** action for this
track. Keep one current recording/profile, but retain the old curriculum sentence,
response and event records needed to reconstruct evidence in a separate archived
curriculum run; discard the old transcript/profile and unused buffers. This needs
an explicit archive ownership migration rather than evading current cascade FKs.
Retained sentence text/English/audio and logs are personal data: describe retention
in the confirmation, allow full deletion through Start over, and do not export them
automatically. The design does not introduce a browsable recording library.
Replacement begins a new source run; transfer to its vocabulary remains uncertain.
Show this action only once its lifecycle tests and consent UI are complete.

## 7. Buffering, serving and concurrency

Adaptive curriculum must not precommit a large FIFO sequence that ignores recent
responses. Start with a curriculum buffer of three voiced candidates and bounded
in-flight generation, independently counted from both crosstalk modes.

Persist plans before external calls. Recheck run/track/catalog/evidence state before
commit and before serving. A changed evidence revision alone does not invalidate a
candidate: re-evaluate its target/support eligibility. Keep usable candidates,
defer temporarily ineligible ones, and discard obsolete catalog/source-run work.
Never relabel a result produced under another plan or policy. No resurrection
after reset or replacement; use run IDs and guarded writes.

Curriculum selection is server-authoritative: claim one next sentence atomically
when the client is ready to promote it, keyed by an idempotent request ID. Return a
lease/token tied to source run and track selection revision. Prefetched audio is
not permission to promote an old queued item. A new track-selection revision
invalidates unstarted claims, not the active presentation. Claims reserve a
sentence briefly; expiry/reload must not consume it or count exposure. Actual
presentation logging establishes exposure. Multi-tab requests cannot claim the
same unstarted sentence concurrently; response remains globally single per sentence.

Add a curriculum-only next/claim route rather than change legacy upcoming semantics
for older clients. The UI uses it only for curriculum and checks request-generation
tokens after switches. Existing crosstalk prefetch/mode-switch semantics remain.
On restart reconcile durable unfinished plans, dirty projections and claims before
replenishing. Prioritise the selected track; inactive buffers must not block it.
Count voiced candidates separately from unvoiced jobs so synthesis failure cannot
create a falsely full buffer. Claim generation work durably if multiple worker
processes are allowed; a process-local serial loop is not a distributed lock.

## 8. Compatibility and experiment separation

This is an explicit scoped exception to ADRs 0003 and 0004: curriculum constructions
may exceed the profile, concept review is scheduled, and telemetry guides future
practice. The original decisions still govern the crosstalk track. Add an ADR at
implementation approval; do not rewrite historical decisions as though they never
applied. The no-Finnish-text contract and trusted binary response remain.

The comprehension embedding experiment remains a separate research effort. Its
existing non-adaptive collection population is not interchangeable with this
adaptive stream. Export immutable track, catalog, selection, authoring, model and
speech versions, selection reason, evidence watermark and predicted state before
presentation. Evaluate future outcomes using only evidence available then; late
events may revise current state but must not retrospectively improve predictions.
Raw responses stay unchanged. Crosstalk events do not update concept estimates in
v1 because their target isolation is unknown.

## 9. Delivery plan and acceptance gates

Each milestone is a reviewable implementation task. Do not run paid providers
without explicit approval. No automatic full-syllabus generation.

### 1 — Curated pilot catalog and executable policy specification

Files: new `src/curriculum/catalog/`, catalog schema/tests and fixture histories.
Create the coverage map, target slice, dependency graph, background grammar,
register policy, family definitions and pinned policy constants.
Validate unique IDs, references, acyclicity, realisation coverage and eligibility.
Gate: simulated histories cannot unlock unsupported targets or deadlock at cold
start. Finnish review of the targets follows when a reviewer is available; until
then targets stay `unreviewed` and review changes bump revisions/catalog version.
Done: `src/curriculum/Catalog.ts`, `src/curriculum/catalog/pilot.ts` (28
targets from the older Suomen mestari 1 progression, plus background grammar).

### 2 — Pure learner model and scheduler

Files: `src/curriculum/CurriculumPolicy.ts` and tests.
Implement evidence classification, revision/rebuild, coverage, uncertainty,
active-set selection, fairness and review. Fixtures cover cold start, translation-
only success, replay success, all failures, easy streaks, retention failures,
changed register, long absence and no eligible targets. Test invariants over
generated histories: no future evidence, no multi-label credit, deterministic
replay, no promotion from unsupported success, bounded starvation.
Gate: a readable decision trace explains every simulated selection.
Done: `CurriculumPolicy.ts` (`classifyObservation`, `estimateTargets`,
`selectNext`, versions `curriculum-model-v1`/`curriculum-selection-v1`) with
simulated-learner tests. Deferred to milestone 3/4, where the data exists:
per-register coverage and alternate-content diagnostics for struggling targets.

### 3 — Additive persistence and reconciliation

Files: `src/db/Database.ts`, new curriculum store, relevant
`src/practice/PracticeStore*.ts` integration and PostgreSQL tests.
Implement track metadata, plans, evidence, projection revisions, claims and
snapshots. Backfill legacy rows without changing practice mode defaults. Integrate
response/event ingestion with transactional dirty marking and durable rebuild.
Gate: late/out-of-order events, retries, concurrent responses, crash/restart,
cross-presentation reveal and reset races converge to the same final projection;
historical crosstalk tests still pass. No live data migration without backup.

### 4 — Controlled authoring and audio

Files: new `CurriculumAuthor`/LLM adapter/tests; reuse `src/speech/`.
Implement structured briefs, review gates, annotations, planned repetition,
diverse transfer, bounded retries and recorded speech configuration. Do not modify
legacy prompt rules. Fake-model tests cover unknown targets, extra glue,
ungrounded vocabulary, register drift, missing contrasts and exhausted generation.
Gate: the learner listens to an approved small paid sample and reports anything
that sounds wrong; a Finnish reviewer checks samples when available. Until then,
the LLM review pass is the only linguistic check—treat early data accordingly.

### 5 — End-to-end stream and track switching

Files: `PracticeWorker.ts`, `Practice.ts`, `src/api/Api.ts`,
`src/http/routes.ts`, `src/domain/model.ts`, `web/api.ts`, `web/main.ts`,
queue/presentation tests and styles as needed.
Implement selected-track dispatch, three-candidate buffering, claim route, UI
selection, durable response outbox and revision-safe promotion. Share the existing
audio/response view. Test offline response retry and event-before-response delivery.
Gate: switch during playback/generation/TTS/fetch; delayed response; reload;
multiple tabs; stale candidates; empty buffer; provider failure. The active
sentence never changes mid-presentation, Finnish never enters public payloads,
and crosstalk-only clients retain their old behaviour.

### 6 — Progress lifetime and documentation

Implement archive ownership and explicit replace-recording action; Start over
deletes all current/archived data, audio, progress and pending work. Test failed
replacement/retry, pending calls, old-tab events and deletion during replacement.
Update README, glossary (proposed terms become implemented), scoped ADR and
experiment documentation; document retention, policy versions and limitations.
Gate: progress survives only the explicitly chosen replacement action; neither
reset nor late network requests can resurrect deleted learner data.

### 7 — Pilot and policy revision

Not started: needs the learner's listening across several days, and consent for
paid generation. Before the first block, listen to a small approved sample and
record the catalog/model/selection/author versions in use.

Opt-in pilot across several listening days. Inspect isolated-target compliance,
success by role/support level/family, missing traces, active-set variety, stuck
targets, review outcomes, wait time, discarded drafts and provider cost. Compare
stored pre-presentation estimates with later self-reports; group related families
when assessing uncertainty. Avoid interpreting rising training success as proof
of retention or causal teaching effectiveness.
Gate: acceptable Finnish quality, useful variety, explainable progression and
evidence of comprehension on fresh/spaced examples. If inconclusive, keep the
small syllabus and revise policy; do not expand coverage to hide poor learning.

Run repository checks at implementation milestones: `./script/lint`, `pnpm test`,
`pnpm build`, and the PostgreSQL suite only with
`CROSSTALK_TEST_DATABASE_URL=postgres://localhost:5432/crosstalk_practice_test`.
That suite destroys its schema: never target the learner database. Browser smoke
tests use fake providers/test data; paid smoke tests require separate consent.

## 10. Decisions still requiring validation, not redesign blockers

- Exact targets/prerequisites and background grammar: Finnish reviewer.
- Numeric evidence weights, promotion gates, active-set size and spacing: pilot.
- Cost/latency of a three-candidate buffer: measurement; adjust under a new policy.
- How much additional predictive value timing signals provide: prospective tests.

Do not defer the product invariants above while investigating these parameters.
The initial deliverable is an auditable adaptive loop, not a claim of a complete
syllabus or a scientifically validated mastery estimator.

# Beginner and intermediate practice modes

Status: implemented. Migration `0003_practice_modes` runs on the next server
start; reload open pages afterwards.

Implementation notes:

- Policy versions live in `generationPolicies` (`src/practice/SentenceAuthor.ts`);
  bump a version whenever that mode's writer or reviewer rules change.
- `stats.buffered` still counts voiced sentences of every mode, so a switch
  never sends a ready session back to the preparation screen; the practice
  screen shows its waiting state until the new mode has sentences.
- Verified by fake-model author tests, PostgreSQL store/worker/HTTP tests
  (including a mid-batch switch and the legacy backfill), browser-queue unit
  tests and a headless Chrome smoke test against the test database. No paid
  generation sample was run: spot-check real Beginner output before relying on
  it for a pilot block.

Supports the collection pilot in [the comprehension experiment](comprehension-experiment-plan.md#0-collect-informative-data-before-judging-the-model).

## Behaviour

- Add a **Practice mode** selector before upload and during practice:
  - **Beginner:** single-clause sentences only.
  - **Intermediate:** current generation rules, without the single-clause restriction.
- Propose Beginner as the default for new practice sessions. Existing sessions
  remain Intermediate so migration does not silently change their behaviour.
- Persist the choice on the practice session, surviving reloads and server
  restarts. “Start over” deletes it with the session; a new session defaults to
  Beginner. A cross-session user preference is outside this change.
- Switching preserves the sentence currently being heard, including its audio,
  translation state, presentation log and eventual response. Show “Applies after
  this sentence.” Subsequent sentences come from the selected mode; show the
  existing waiting state if none are ready.
- Beginner is a generation constraint, not a claim that a sentence is objectively
  easy or that the learner will understand it. No automatic switching or predictor
  integration.

## 1. Domain, storage and API

Files: `src/domain/model.ts`, `src/db/Database.ts`,
`src/practice/PracticeStore.ts`, `src/practice/PracticeStorePostgres.ts`.

- Define a shared schema/type with `beginner` and `intermediate` values.
- Add the selected mode to the stored session and session views.
- Store immutable generation mode and generation-policy version on each sentence.
  Backfill existing sentences as Intermediate with a distinct legacy policy
  version: this describes their generation rules, not their actual clause count.
- Retain unanswered sentences from the other mode rather than deleting them.
  Filter upcoming sentences, buffer counts and pending synthesis by selected
  mode. Switching back can reuse that mode's buffer. Retain global duplicate
  prevention, recent-sentence context and response-based struggles.
- Keep responses and presentations valid regardless of the session's current
  mode, including delayed event delivery and responses from another open tab.

Files: `src/api/Api.ts`, `src/practice/Practice.ts`, `src/http/routes.ts`.

- Accept the initial mode on upload; omitted values from older clients retain
  Intermediate behaviour. The new UI explicitly submits its selection.
- Add a schema-validated session-mode update endpoint returning authoritative
  session state. Reject invalid values and absent sessions through the normal
  API error conventions. Repeating the same selection is harmless.
- Persist the selection before waking the worker. Expose generation mode on
  practice items so clients can distinguish the current sentence from the
  requested mode and reject stale prefetched items.

## 2. Generation and review

Files: `src/practice/SentenceAuthor.ts`, `src/practice/LlmSentenceAuthor.ts`.

- Extend `SentenceBrief` with mode; leave session-profile analysis unchanged.
- Keep all current writer constraints: profile grounding, register, standalone
  meaning, novelty, mostly 4–14 words, struggle variations and translations.
- Append this rule only for Beginner:

  > Every Finnish sentence must contain exactly one independent clause. Do not
  > use subordinate, relative or coordinated clauses, or combine multiple
  > sentences. Express one complete idea. Apply this restriction to variations
  > too, simplifying a multi-clause struggle to one clause while retaining useful
  > key vocabulary. Keep all other requirements.

- Define examples for the writer and reviewer: `Ostan leipää kaupasta.` qualifies;
  `Ostan leipää, koska olen nälkäinen.` does not. Coordinated nouns are not
  automatically coordinated clauses; Finnish auxiliaries/negation are not
  automatically additional clauses. Avoid word-count or punctuation heuristics
  as substitutes for linguistic review.
- Pass mode to the existing editor call and add a single-clause verdict.
  Beginner acceptance requires that verdict plus all existing quality checks.
  Intermediate acceptance uses the existing checks only; it does not require
  multi-clause sentences.
- Retain bounded unproductive-generation handling. Never silently relax Beginner
  when too few drafts pass. LLM review reduces violations but is not a formal
  grammatical guarantee; manually inspect a small Finnish sample during rollout.

## 3. Buffered generation and switching races

File: `src/practice/PracticeWorker.ts` and the store implementations.

- Read the current mode for each replenishment round, snapshot it into the brief,
  and stamp resulting sentences with that same mode/policy version.
- If the learner switches during an LLM/TTS call, its results keep the original
  mode; they must never be relabelled or served as the new mode. Re-read session
  state before further work, prioritising the newly selected mode.
- Commit sentence metadata with sentence insertion. Preserve existing safeguards
  against a concurrent “Start over”; do not recreate deleted sessions.
- Scope buffer counts to the selected mode so an old full buffer cannot prevent
  Beginner generation. Already-running synthesis may finish, but avoid starting
  more synthesis for inactive-mode sentences.

## 4. UI integration

Files: `web/api.ts`, `web/main.ts`, `web/styles.css`.

- Add a labelled, keyboard-accessible two-option control on upload and practice
  screens, with the short descriptions above. Keep the setting available while
  waiting for new sentences.
- Disable overlapping saves and report save failures without pretending the
  setting changed. Preserve existing playback and response interactions.
- On successful switching, clear future client-prefetched items, not the active
  presentation. Ignore stale upcoming responses using a request-generation token;
  refresh under the authoritative mode before promoting another item.
- Reconcile mode from server state on reload/polling, including changes in another
  tab. Do not restart the active presentation just because settings changed.

## 5. Experiment compatibility

- Sentence-level mode/policy snapshots allow later exports to recover the actual
  generation policy even after many switches. Include them in the future export
  described in the experiment plan; do not infer historical mode from the current
  session setting.
- No changes to comprehension labels, presentation-event semantics, embeddings,
  or prediction. Mode is not an observed difficulty label.
- Document the new collection policy before collecting a pilot block. Review
  success rates by mode; freeze the switching/selection policy before formal
  evaluation, as required by the experiment plan.

## 6. Verification and delivery order

1. Schema, migration, store and API: test defaults, legacy backfill, persistence,
   invalid input, missing session and idempotent updates.
2. Author/reviewer: fake model tests verify both prompts, all existing quality
   gates, Beginner rejection of multiple clauses, Intermediate acceptance without
   that restriction, variations and exhausted retries. No paid API calls in tests.
3. Worker/store: test mode-specific buffers, switching during generation/synthesis,
   switching back, reset races, and preserved history/late responses and events.
4. UI: test switching with active audio and translation, stale prefetch responses,
   save failure, rapid interaction, waiting, reload and cross-tab reconciliation.
5. Run `./script/lint`, `pnpm test`, and `pnpm build`; use only the dedicated
   disposable database for integration tests. Perform a browser smoke test and an
   explicitly opt-in small generation sample for linguistic review.
6. Update `CONTEXT.md`, `README.md`, and the experiment plan to describe the
   implemented behaviour and its collection-policy version.

Acceptance: Beginner applies the single-clause writer and reviewer constraint;
Intermediate preserves current authoring behaviour; neither stale server buffers
nor client prefetch can supply the wrong mode after the current sentence; no
practice history is lost on switching.

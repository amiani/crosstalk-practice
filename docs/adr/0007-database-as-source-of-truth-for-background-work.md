# The database is the source of truth for background work

Preparation and sentence generation run in one background worker that, whenever woken and at least every 30 seconds, reads the stored practice session and does whatever is missing; there is no job queue or in-memory pipeline state, so a restart simply resumes. Everything the learner may need again, including sentence audio, lives in PostgreSQL so a single reset or backup covers it, while the source recording stays on disk only until transcription succeeds.

## Consequences

- Only one app instance may run against a database; two would both process the same practice session.

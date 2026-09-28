# The curriculum track adapts to evidence

Curriculum practice ("Building blocks") is a second practice track beside crosstalk practice. Its sentences teach grammar and function concepts from a versioned catalog, may use constructions the recording never contained, are chosen by a deterministic learner model that schedules review of earlier concepts, and let presentation-log facts (playback, reveals, trace completeness) shape that model. This is a scoped exception to [0003](0003-generation-bounded-by-session-profile.md), [0004](0004-binary-trusted-responses-without-scheduling.md) and the presentation log's "never steers practice" rule: those still govern crosstalk practice unchanged.

We chose a separate track over a stricter Beginner mode because the learner found content words learnable from crosstalk but not the connecting grammar, and teaching that needs deliberate, recycled exposure to one concept at a time rather than easier free-form sentences. The response stays binary and trusted as a report; what changes is that its meaning depends on the listen (translation-supported successes and unfair listens are not independent evidence), and a sentence counts at most once.

Curriculum evidence is stored per learner, not per recording, so replacing a recording keeps progress; only Start over deletes it. Concept estimates are heuristic support scores behind promotion gates, never shown to the learner and not a claim of mastery.

## Considered Options

- **Stricter Beginner policy or a third practice mode**: rejected; modes constrain free-form generation, while this needs a curriculum, scheduling and evidence.
- **Constructions only from the recording**: rejected; progression would depend on what happened to be said.
- **Let an LLM judge readiness**: rejected; LLMs realise plans and review sentences, the pure policy decides progression.

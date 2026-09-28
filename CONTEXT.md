# Crosstalk Practice

A personal listening-comprehension trainer for a learner of Finnish. It turns the recording of a crosstalk session into an endless stream of new, spoken Finnish sentences, either drawn from what the learner actually heard or teaching the grammar that connects those words, to practise between sessions.

## Language

### Crosstalk

**Crosstalk**:
A language-learning technique in which a native speaker talks only in the target language, illustrating with sketches, while the learner replies only in their own language.
_Avoid_: Lesson, tutoring

**Crosstalk session**:
One live crosstalk conversation between the native speaker and the learner.
_Avoid_: Session (unqualified), class

**Native speaker**:
The person in a crosstalk session who speaks Finnish, whether teacher or not.
_Avoid_: Teacher, tutor, speaker 1

**Learner**:
The single user of this tool: a native English speaker learning Finnish.
_Avoid_: Student, user, speaker 2

**Recording**:
The audio of one crosstalk session, captured with any other tool and uploaded afterwards.
_Avoid_: Upload, file, clip

### Preparation

**Practice session**:
Everything prepared from one recording: its transcript, session profile, practice sentences and responses. At most one exists at a time.
_Avoid_: Session (unqualified), deck, course

**Transcript**:
What was heard in a recording, in both languages, as a sequence of turns attributed to the native speaker or the learner.
_Avoid_: Transcription (for the artefact), captions

**Turn**:
One uninterrupted stretch of speech by one person in a transcript.
_Avoid_: Segment, line

**Heard utterance**:
A piece of Finnish from the transcript judged clearly heard and meaningful, paired with its English translation.
_Avoid_: Sentence (reserve for practice sentences), phrase

**Discarded snippet**:
Finnish in the transcript left out of the session profile because it was unclear, garbled or implausible.
_Avoid_: Error, noise

**Session profile**:
The stable description of the Finnish a practice session may draw on: heard utterances, vocabulary, constructions, register, topics and a summary.
_Avoid_: Corpus, analysis, context

**Register**:
How the native speaker talked: spoken or standard forms, formality and pace.
_Avoid_: Style, tone

**Insufficient material**:
A recording that yields too few heard utterances to ground practice.
_Avoid_: Empty recording

**Preparation stage**:
Where a new practice session is before practice can begin: transcribing, analyzing, or generating the first practice sentences.
_Avoid_: Status, step

### Practice

**Practice sentence**:
A new, standalone Finnish sentence written within the session profile, heard as audio and never shown as Finnish text.
_Avoid_: Question, card, item, exercise

**Translation**:
The English meaning of a practice sentence, hidden until the learner reveals it.
_Avoid_: Answer, hint, solution

**Response**:
The learner's single judgement of a practice sentence: understood or didn't understand.
_Avoid_: Answer, grade, score

**Presentation**:
One showing of a practice sentence in the browser, from appearing on screen until the learner responds or leaves. Reloading shows the sentence again as a new presentation; a response belongs to exactly one.
_Avoid_: Attempt, trial, view

**Presentation log**:
The append-only record of what happened during a presentation (playbacks, replays, translation reveals, visibility changes, the response), with timings. Kept for studying comprehension; it never steers crosstalk practice, but it qualifies curriculum evidence.
_Avoid_: Analytics, telemetry, history

**Struggle**:
A practice sentence the learner recently responded to as not understood.
_Avoid_: Mistake, failure, wrong answer

**Variation**:
A practice sentence written as a simpler, genuinely different take on a struggle.
_Avoid_: Retry, repeat, rephrasing

**Practice stream**:
The endless sequence of practice sentences the learner listens through, with no batches, end or score.
_Avoid_: Quiz, drill set, lesson

**Practice mode**:
The learner's choice of which generation constraints new crosstalk practice sentences must meet: **beginner** (single-clause sentences only) or **intermediate** (no clause restriction). Switching applies after the sentence currently being heard. A mode describes how a sentence was written, not how hard the learner found it. Curriculum sentences have no mode.
_Avoid_: Difficulty, level (in code), grade

**Generation policy**:
The versioned set of authoring rules a practice sentence was written under, stored with it alongside its practice mode, so later analysis can tell sentences written under different rules apart.
_Avoid_: Prompt version, settings

**Start over**:
Discarding the practice session and everything in it, including all curriculum evidence, to make way for a new recording.
_Avoid_: Reset (in learner-facing language), delete

**New recording**:
Discarding the practice session to make way for a new recording while keeping curriculum evidence.
_Avoid_: Start over (which also deletes progress)

### Curriculum practice

**Practice track**:
The choice between crosstalk practice grounded in a recording's language and
curriculum practice guided by a sequence of grammar and function concepts
(shown to the learner as "Conversation" and "Building blocks"). Switching
applies after the sentence currently being heard.
_Avoid_: Practice mode, difficulty

**Curriculum practice**:
Listening practice that teaches grammar and function concepts using vocabulary,
register and interests drawn from crosstalk. Its constructions need not have
occurred in the recording.
_Avoid_: Grammar exercises, course (in learner-facing language)

**Learning target**:
A small meaning distinction and the Finnish forms or constructions that express
it, narrow enough to isolate in listening examples.
_Avoid_: Function word (when the meaning spans a construction), chapter

**Active set**:
The few learning targets receiving concurrent focused practice, interleaved for
variety alongside reviews of earlier targets. Free slots take the earliest
eligible targets in catalog order.
_Avoid_: Lesson, batch

**Background grammar**:
Grammar a curriculum sentence may use without assessing it, once its required
learning targets are established. Includes form rules a comprehension response
cannot isolate, such as vowel harmony and verb types.
_Avoid_: Scaffold, chapter

**Primary target**:
The learning target a practice sentence deliberately isolates; other constructions
serve as supporting material rather than independent comprehension observations.
Supporting material comes from established targets and from other active targets
the learner has met several times and is not struggling with.
_Avoid_: Only grammar in the sentence

**Transfer sentence**:
A fresh example of a learning target with a different combination of familiar
content, used to estimate whether understanding extends beyond recent examples.
A target that meets every other promotion gate gets a transfer sentence next
(a **transfer check**), one outstanding at a time.
_Avoid_: Test, quiz (in learner-facing language)

**Review sentence**:
A new sentence revisiting an earlier learning target after intervening practice
or time, rather than replaying an answered sentence.
_Avoid_: Repeated card

**Comprehension estimate**:
An uncertain assessment of the learner's understanding of a learning target,
informed by responses, listening support, variation and later review.
_Avoid_: Verified mastery, objective knowledge score

**Curriculum evidence**:
What one response to a curriculum sentence says about its primary target, given
how it was listened to: an unaided success, a success after replaying, a success
only with the translation, a failure, or not a fair listen. Refined as the
presentation log arrives; kept across new recordings.
_Avoid_: Score, label, grade

**Established target**:
A learning target understood well enough, on fresh and varied sentences, to
unlock the targets that depend on it. Promotion needs, among other gates, two
transfer sentences understood from the audio alone (no translation), not back
to back. Reversible after failed reviews. Not stored: recomputed from curriculum
evidence on every decision.
_Avoid_: Mastered, learned, completed

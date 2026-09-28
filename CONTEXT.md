# Crosstalk Practice

A personal listening-comprehension trainer for a learner of Finnish. It turns the recording of a crosstalk session into an endless stream of new, spoken Finnish sentences drawn from what the learner actually heard, to practise between sessions.

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
The append-only record of what happened during a presentation (playbacks, replays, translation reveals, visibility changes, the response), with timings. Kept for studying comprehension; it never steers practice.
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
The learner's choice of which generation constraints new practice sentences must meet: **beginner** (single-clause sentences only) or **intermediate** (no clause restriction). Switching applies after the sentence currently being heard. A mode describes how a sentence was written, not how hard the learner found it.
_Avoid_: Difficulty, level (in code), grade

**Generation policy**:
The versioned set of authoring rules a practice sentence was written under, stored with it alongside its practice mode, so later analysis can tell sentences written under different rules apart.
_Avoid_: Prompt version, settings

**Start over**:
Discarding the practice session and everything in it to make way for a new recording.
_Avoid_: Reset (in learner-facing language), delete

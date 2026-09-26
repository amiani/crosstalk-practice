# Transcription by a multimodal model, not a dedicated speech-to-text model

On a real crosstalk recording, the planned Gemini 3.5 Transcribe kept the Finnish but silently dropped all of the learner's English, including every "I don't understand", and speaker diarization made it worse. We therefore transcribe with a general multimodal model (Gemini 3.8 Flash) that returns each turn labelled native speaker or learner, with its language and whether it was confident; the dedicated model stays selectable with `TRANSCRIBER=stt` for comparison.

## Consequences

- Recordings are transcribed in three-minute pieces because OpenRouter warns that upstream providers time out after about a minute per request. A word straddling a cut may be lost, and one piece that still fails after retries fails the whole transcription.

# OpenRouter as the only AI gateway

All model access (transcription, profiling, sentence writing, review and speech) goes through OpenRouter with one API key. We first built direct Gemini adapters and replaced them once OpenRouter proved to serve the same models, keeping speech behind `Transcriber` and `SpeechSynthesizer` interfaces and text models behind Effect AI's `LanguageModel` so a vendor change stays a layer swap.

## Consequences

- Structured output needs strict JSON schemas and `require_parameters`; without them Gemini answers in prose.
- Gemini speech through OpenRouter comes back only as raw PCM, which is wrapped as WAV before storage.

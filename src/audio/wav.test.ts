import { describe, expect, it } from "vitest";

import { pcmFormatFromContentType, pcmToWav } from "./wav.ts";

const fallback = { bitsPerSample: 16, channels: 1, sampleRate: 24000 };

describe("pcmFormatFromContentType", () => {
  it("reads rate and channels", () => {
    expect(
      pcmFormatFromContentType("audio/pcm;rate=16000;channels=2", fallback),
    ).toEqual({ bitsPerSample: 16, channels: 2, sampleRate: 16000 });
  });

  it("falls back when parameters are missing", () => {
    expect(pcmFormatFromContentType("audio/pcm", fallback)).toEqual(fallback);
    expect(pcmFormatFromContentType(undefined, fallback)).toEqual(fallback);
  });
});

describe("pcmToWav", () => {
  it("writes a canonical 44-byte header", () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]), fallback);
    const view = new DataView(wav.buffer);
    const text = (offset: number) =>
      String.fromCharCode(...wav.slice(offset, offset + 4));
    expect(wav.byteLength).toBe(48);
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4]);
  });
});

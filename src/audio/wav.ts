/** Raw PCM layout as reported by a provider. */
export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

/**
 * Reads `audio/pcm;rate=24000;channels=1`-style content types. Missing
 * parameters fall back to `fallback`; 16-bit samples are assumed.
 */
export const pcmFormatFromContentType = (
  contentType: string | undefined,
  fallback: PcmFormat,
): PcmFormat => {
  const parameters = new Map(
    (contentType ?? "")
      .split(";")
      .slice(1)
      .map((part) => part.trim().split("=") as [string, string | undefined])
      .map(([key, value]) => [key.toLowerCase(), Number(value)]),
  );
  const positive = (value: number | undefined, otherwise: number) =>
    value !== undefined && Number.isInteger(value) && value > 0
      ? value
      : otherwise;
  return {
    bitsPerSample: fallback.bitsPerSample,
    channels: positive(parameters.get("channels"), fallback.channels),
    sampleRate: positive(parameters.get("rate"), fallback.sampleRate),
  };
};

/** Prepends a RIFF/WAVE header so browsers can play little-endian PCM. */
export const pcmToWav = (pcm: Uint8Array, format: PcmFormat): Uint8Array => {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
};

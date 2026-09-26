/**
 * Identity of a sentence for duplicate detection: case, punctuation and
 * whitespace differences do not make a sentence new.
 */
export const normalizeSentence = (sentence: string): string =>
  sentence
    .normalize("NFC")
    .toLocaleLowerCase("fi")
    .replaceAll(/[^\p{L}\p{N}\s]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

import type { PageText } from "./layout-parser";

export const TARGET_CHUNK_CHARS = 400;
export const OVERLAP_SENTENCES = 2;
// Text with no punctuation (tables, lists) would otherwise become one giant "sentence".
const MAX_SENTENCE_CHARS = 1000;

// A sentence ends at . ! ? (plus closing quotes/brackets); the last piece may have no end mark.
const SENTENCE_REGEX = /[^.!?]+(?:[.!?]+["')\]”’]*|$)/g;
const ABBREVIATION = /(?:\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|No|Nos|Fig|Figs|Inc|Co|Corp|Ltd|vs|etc|approx|Sec|Vol|e\.g|i\.e|U\.S|U\.K|a\.m|p\.m)|\b[A-Z])\.$/;

export interface Chunk {
  text: string;
  /** Page where the chunk starts. */
  pageNumber: number;
  sentenceCount: number;
  /** Sentences repeated from the end of the previous chunk (0 for the first). */
  overlapSentences: number;
}

interface Sentence {
  text: string;
  pageNumber: number;
}

function splitLong(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_SENTENCE_CHARS) {
    const cut = rest.lastIndexOf(" ", TARGET_CHUNK_CHARS * 2);
    const at = cut > 0 ? cut : TARGET_CHUNK_CHARS * 2;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Splits the whole document at once, so a sentence that runs from one page to
 * the next stays in one piece. Each sentence is tagged with the page it starts on.
 */
export function splitSentences(pages: PageText[]): Sentence[] {
  let full = "";
  const starts: { offset: number; pageNumber: number }[] = [];
  for (const page of pages) {
    if (!page.text) continue;
    starts.push({ offset: full.length, pageNumber: page.pageNumber });
    full += page.text + " ";
  }

  const pageAt = (offset: number) => {
    let found = starts[0]?.pageNumber ?? 1;
    for (const s of starts) {
      if (s.offset > offset) break;
      found = s.pageNumber;
    }
    return found;
  };

  const sentences: Sentence[] = [];
  for (const match of full.matchAll(SENTENCE_REGEX)) {
    const text = match[0].trim();
    if (!text) continue;
    const pageNumber = pageAt(match.index ?? 0);
    const last = sentences[sentences.length - 1];
    // "Dr." or "U.S." is not a real sentence end: glue it to what follows.
    if (last && ABBREVIATION.test(last.text)) last.text += " " + text;
    else sentences.push({ text, pageNumber });
  }

  return sentences.flatMap((s) =>
    s.text.length > MAX_SENTENCE_CHARS
      ? splitLong(s.text).map((text) => ({ text, pageNumber: s.pageNumber }))
      : [s],
  );
}

/**
 * Accumulates whole sentences until the target length is reached, then starts
 * the next chunk with the last OVERLAP_SENTENCES sentences. Chunks can cross
 * page borders; each one records the page it starts on.
 */
export function chunkPages(
  pages: PageText[],
  targetChars = TARGET_CHUNK_CHARS,
  overlap = OVERLAP_SENTENCES,
): Chunk[] {
  const sentences = splitSentences(pages);
  const chunks: Chunk[] = [];
  let overlapUsed = 0;
  let start = 0;

  while (start < sentences.length) {
    let end = start;
    let length = 0;
    while (end < sentences.length && length < targetChars) {
      length += sentences[end].text.length + 1;
      end++;
    }

    chunks.push({
      text: sentences.slice(start, end).map((s) => s.text).join(" "),
      pageNumber: sentences[start].pageNumber,
      sentenceCount: end - start,
      overlapSentences: overlapUsed,
    });
    if (end >= sentences.length) break;

    // Step back for overlap, but always advance at least one sentence.
    const nextStart = Math.max(end - overlap, start + 1);
    overlapUsed = end - nextStart;
    start = nextStart;
  }

  return chunks;
}

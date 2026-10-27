import PDFParser from "pdf2json";

export interface PageText {
  pageNumber: number;
  text: string;
}

interface Item {
  x: number;
  y: number;
  w: number;
  text: string;
}

interface RawPage {
  width: number;
  height: number;
  items: Item[];
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Items whose y differs by less than this are on the same visual line
// (bold/italic/superscript fragments are often a hair off).
const LINE_TOLERANCE = 0.25;
const MIN_COLUMN_ITEMS = 8;
const MIN_COLUMN_TEXT_LENGTH = 12;

// Top-to-bottom by line, then left-to-right inside each line.
function sortTopToBottom(items: Item[]): Item[] {
  const byY = [...items].sort((a, b) => a.y - b.y);
  const lines: Item[][] = [];
  for (const item of byY) {
    const line = lines[lines.length - 1];
    if (line && item.y - line[0].y <= LINE_TOLERANCE) line.push(item);
    else lines.push([item]);
  }
  return lines.flatMap((line) => line.sort((a, b) => a.x - b.x));
}

// A fragment that starts inside the previous one's width, with no space on
// either side, is the same word ("201" + "8", "S" + "ection").
const JOIN_RATIO = 0.95;

function toText(items: Item[]): string {
  let out = "";
  let prev: Item | null = null;
  for (const item of sortTopToBottom(items)) {
    if (!item.text.trim()) {
      out += " ";
      continue;
    }
    const sameWord =
      prev !== null &&
      Math.abs(item.y - prev.y) <= LINE_TOLERANCE &&
      !/\s$/.test(prev.text) &&
      !/^\s/.test(item.text) &&
      item.x - prev.x < prev.w * JOIN_RATIO;
    out += (sameWord ? "" : " ") + item.text;
    prev = item;
  }
  return cleanText(out);
}

/** Collapses whitespace and glues words hyphenated across a line break ("infor- mation"). */
function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([a-z])- ([a-z])/g, "$1$2")
    .trim();
}

// Header/footer detection: text in the top/bottom band that repeats on many pages.
const MARGIN_BAND = 0.12;
// Bare numbers (page numbers) hug the edge; a number higher up is likely part of a heading.
const NUMBER_MARGIN_BAND = 0.07;
const MIN_REPEAT_PAGES = 3;

function marginKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function inMargin(item: Item, height: number): boolean {
  const band = /^[\d\s]*$/.test(item.text) ? NUMBER_MARGIN_BAND : MARGIN_BAND;
  return item.y < height * band || item.y > height * (1 - band);
}

function removeRepeatedMargins(pages: RawPage[]): void {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const item of page.items) {
      const key = marginKey(item.text);
      if (key && inMargin(item, page.height)) seen.add(key);
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const minPages = Math.max(MIN_REPEAT_PAGES, Math.ceil(pages.length * 0.1));
  for (const page of pages) {
    page.items = page.items.filter((item) => {
      if (!inMargin(item, page.height)) return true;
      const key = marginKey(item.text);
      return !key || (counts.get(key) ?? 0) < minPages;
    });
  }
}

/**
 * Returns the x where the right column starts, or null for a single-column page
 * (title page, index, contents...). A real second column has many long text
 * lines starting at the same x, spread down the page. Right-aligned page
 * numbers in an index are short, so they don't qualify.
 */
function findColumnSplit(items: Item[], pageWidth: number): number | null {
  const right = items.filter((i) => i.x >= pageWidth * 0.4 && i.text.trim().length > 0);
  if (right.length < MIN_COLUMN_ITEMS) return null;

  const bins = new Map<number, Item[]>();
  for (const i of right) {
    const key = Math.round(i.x * 2) / 2;
    bins.set(key, [...(bins.get(key) ?? []), i]);
  }
  const [edge, cluster] = [...bins.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  const avgLength = cluster.reduce((s, i) => s + i.text.trim().length, 0) / cluster.length;
  const ys = items.map((i) => i.y);
  const pageSpan = Math.max(...ys) - Math.min(...ys);
  const clusterSpan = Math.max(...cluster.map((i) => i.y)) - Math.min(...cluster.map((i) => i.y));
  const leftCount = items.filter((i) => i.x < edge - 1).length;

  const isColumn =
    cluster.length >= MIN_COLUMN_ITEMS &&
    avgLength >= MIN_COLUMN_TEXT_LENGTH &&
    clusterSpan >= pageSpan * 0.25 &&
    leftCount >= MIN_COLUMN_ITEMS;
  return isColumn ? edge - 0.5 : null;
}

export function parsePdfBuffer(buffer: Buffer): Promise<PageText[]> {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();

    parser.on("pdfParser_dataError", (err) =>
      reject(err instanceof Error ? err : err.parserError),
    );

    parser.on("pdfParser_dataReady", (pdf) => {
      const raw: RawPage[] = pdf.Pages.map((page) => ({
        width: page.Width,
        height: page.Height,
        items: page.Texts.map((t) => ({
          x: t.x,
          y: t.y,
          w: t.w,
          text: t.R.map((r) => decode(r.T)).join(""),
        })),
      }));

      removeRepeatedMargins(raw);

      resolve(
        raw.map((page, idx) => {
          const split = findColumnSplit(page.items, page.width);
          const columns =
            split === null
              ? [page.items]
              : [page.items.filter((i) => i.x < split), page.items.filter((i) => i.x >= split)];

          return {
            pageNumber: idx + 1,
            text: columns.map(toText).filter(Boolean).join(" "),
          };
        }),
      );
    });

    parser.parseBuffer(buffer);
  });
}

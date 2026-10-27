import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { MongoClient, type Collection, type ObjectId } from "mongodb";

export const DB_NAME = "advanced_rag";
export const COLLECTION = "gpo_report_pipeline1";
export const VECTOR_INDEX = "gpo_vector_index_384";
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
// Tried in order: a 503 (overloaded) or 404 (retired) on one model falls through to the next.
export const CHAT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
];
export const EMBEDDING_DIM = 384;

const RRF_K = 60;
const CANDIDATES = 20;
const TOP_K = 5;
// Best cosine similarity below this means the question is unrelated to the document.
export const MIN_SIMILARITY = 0.24;
export const NOT_FOUND_ANSWER = "I could not find this in the document.";

export interface ChunkPayload {
  text: string;
  pageNumber: number;
  chunkIndex: number;
}

export const READING_METHOD = "Layout-aware (auto 1/2-column per page, header/footer removal, pdf2json)";
export const CHUNKING_METHOD = "Sentence-aware (~400 chars, 2-sentence overlap, crosses pages)";

/** Per-chunk metadata shown on the /chunks page. Optional: older rows lack it. */
export interface ChunkMeta {
  fileName?: string;
  readingMethod?: string;
  chunkingMethod?: string;
  sentenceCount?: number;
  overlapSentences?: number;
  charLength?: number;
}

export interface ChunkDoc extends ChunkPayload, ChunkMeta {
  embedding: number[];
}

export interface SearchResult extends ChunkPayload {
  id: string;
  score: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in advanced-rag-nextjs/.env.local`);
  return v;
}

// Cached on globalThis so dev HMR doesn't open a new connection per reload.
const g = globalThis as unknown as {
  _mongo?: Promise<MongoClient>;
  _genai?: GoogleGenAI;
  _extractor?: Promise<Extractor>;
};

export function getGenAI(): GoogleGenAI {
  return (g._genai ??= new GoogleGenAI({ apiKey: requireEnv("GOOGLE_API_KEY") }));
}

export async function getCollection(): Promise<Collection<ChunkDoc>> {
  g._mongo ??= new MongoClient(requireEnv("MONGODB_URI")).connect();
  const client = await g._mongo;
  return client.db(DB_NAME).collection<ChunkDoc>(COLLECTION);
}

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

// Local embedding model (no API key, no quota). Cached across HMR reloads.
async function getExtractor(): Promise<Extractor> {
  g._extractor ??= import("@xenova/transformers").then(
    (m) => m.pipeline("feature-extraction", EMBEDDING_MODEL) as unknown as Promise<Extractor>,
  );
  return g._extractor;
}

export async function embed(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const res = await extractor(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

const RETRYABLE = /503|UNAVAILABLE|404|NOT_FOUND|429|RESOURCE_EXHAUSTED/;
// Index of the model that worked last, so later questions skip models known to fail.
let preferredModel = 0;

function modelConfig(systemInstruction: string, thinking: boolean) {
  return {
    systemInstruction,
    temperature: 0,
    // Lookup-style answers don't need long reasoning; minimal thinking is much faster.
    ...(thinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {}),
  };
}

/** Streams the answer. Falls through the model list only before the first text arrives. */
export async function* generateAnswerStream(
  systemInstruction: string,
  contents: string,
): AsyncGenerator<string> {
  let lastError: unknown;
  for (let n = 0; n < CHAT_MODELS.length; n++) {
    const index = (preferredModel + n) % CHAT_MODELS.length;
    for (const thinking of [true, false]) {
      try {
        const stream = await getGenAI().models.generateContentStream({
          model: CHAT_MODELS[index],
          contents,
          config: modelConfig(systemInstruction, thinking),
        });
        let started = false;
        for await (const part of stream) {
          if (!part.text) continue;
          started = true;
          yield part.text;
        }
        if (started) {
          preferredModel = index;
          return;
        }
        break; // empty reply: try the next model
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (thinking && /400|INVALID_ARGUMENT/.test(msg)) continue; // model rejects thinking config
        if (!RETRYABLE.test(msg)) throw err;
        break;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All Gemini models are busy right now. Please try again in a minute.");
}

/** Loads the embedding model ahead of the first question. */
export function warmUp(): void {
  getExtractor().catch(() => {});
}

let indexesReady = false;

export async function ensureIndexes(): Promise<void> {
  if (indexesReady) return;
  const col = await getCollection();
  await col.createIndex({ text: "text" });

  // Atlas Vector Search index. Not available on a local mongod; search falls back
  // to an in-app cosine scan in that case.
  try {
    const existing = await col.listSearchIndexes(VECTOR_INDEX).toArray();
    if (existing.length === 0) {
      await col.createSearchIndex({
        name: VECTOR_INDEX,
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIM, similarity: "cosine" },
          ],
        },
      });
    }
  } catch (err) {
    console.warn("Vector search index not created (not Atlas?):", (err as Error).message);
  }
  indexesReady = true;
}

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are was were be been by at as from that this these those it its what which who whom how when where why do does did has have had not no can could should would about into than then there their they them you your we our i".split(
    " ",
  ),
);

function keywords(question: string): string[] {
  const terms = question
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return [...new Set(terms ?? [])];
}

type Row = ChunkPayload & { _id: ObjectId; score: number };

function toResult(r: Row): SearchResult {
  return {
    id: String(r._id),
    score: r.score,
    text: r.text,
    pageNumber: r.pageNumber,
    chunkIndex: r.chunkIndex,
  };
}

// When $vectorSearch errors (no Atlas index), skip it for a while instead of failing on every question.
let vectorSearchRetryAt = 0;

async function denseSearch(question: string): Promise<SearchResult[]> {
  const col = await getCollection();
  const [queryVector] = await embed([question]);

  if (Date.now() >= vectorSearchRetryAt) try {
    const rows = await col
      .aggregate<Row>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: "embedding",
            queryVector,
            numCandidates: 200,
            limit: CANDIDATES,
          },
        },
        {
          $project: {
            text: 1,
            pageNumber: 1,
            chunkIndex: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();
    // Atlas reports cosine as (1 + cos) / 2; convert back so both paths share one scale.
    if (rows.length > 0) return rows.map((r) => toResult({ ...r, score: 2 * r.score - 1 }));
  } catch {
    vectorSearchRetryAt = Date.now() + 60_000;
  }

  // Fallback: index missing, still building, or non-Atlas MongoDB.
  const docs = (await col.find({}).toArray()).filter((d) => d.embedding.length === EMBEDDING_DIM);
  return docs
    .map((d) => ({
      _id: d._id as ObjectId,
      text: d.text,
      pageNumber: d.pageNumber,
      chunkIndex: d.chunkIndex,
      score: d.embedding.reduce((s, x, i) => s + x * queryVector[i], 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES)
    .map(toResult);
}

// Sparse search via MongoDB's $text index, ranked by textScore.
async function keywordSearch(question: string): Promise<SearchResult[]> {
  const terms = keywords(question);
  if (terms.length === 0) return [];

  const col = await getCollection();
  const rows = await col
    .aggregate<Row>([
      { $match: { $text: { $search: terms.join(" ") } } },
      {
        $project: {
          text: 1,
          pageNumber: 1,
          chunkIndex: 1,
          score: { $meta: "textScore" },
        },
      },
      { $sort: { score: -1 } },
      { $limit: CANDIDATES },
    ])
    .toArray();
  return rows.map(toResult);
}

/** RRF_Score(d) = sum over rankings of 1 / (60 + rank(d)), rank starting at 1. */
export function reciprocalRankFusion(rankings: SearchResult[][]): SearchResult[] {
  const fused = new Map<string, SearchResult>();

  for (const ranking of rankings) {
    ranking.forEach((doc, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const existing = fused.get(doc.id);
      if (existing) existing.score += contribution;
      else fused.set(doc.id, { ...doc, score: contribution });
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export interface HybridResult {
  chunks: SearchResult[];
  /** Cosine similarity of the closest chunk: how related the question is to the document. */
  topSimilarity: number;
}

export async function hybridSearch(question: string): Promise<HybridResult> {
  const [dense, sparse] = await Promise.all([denseSearch(question), keywordSearch(question)]);
  return {
    chunks: reciprocalRankFusion([dense, sparse]).slice(0, TOP_K),
    topSimilarity: dense[0]?.score ?? 0,
  };
}

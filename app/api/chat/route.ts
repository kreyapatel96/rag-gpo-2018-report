import { NextRequest, NextResponse } from "next/server";
import {
  MIN_SIMILARITY,
  NOT_FOUND_ANSWER,
  generateAnswerStream,
  hybridSearch,
  warmUp,
} from "@/lib/rag/hybrid-search";

const SYSTEM_PROMPT =
  "Answer using ONLY the provided numbered context passages. Never use outside knowledge, " +
  "even for well-known facts. Quote exact numbers and dates. Cite passages as [1], [2]. " +
  `If the passages do not contain the answer, reply exactly: '${NOT_FOUND_ANSWER}'`;

function plainStream(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(encoder.encode(JSON.stringify({ citations: [] }) + "\n" + text), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

warmUp();

/**
 * Streamed response: the first line is a JSON object with the citations, the
 * rest is the answer text as it is generated.
 */
export async function POST(req: NextRequest) {
  try {
    const { question } = (await req.json()) as { question?: string };

    if (!question?.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const { chunks, topSimilarity } = await hybridSearch(question);
    // Unrelated question: skip Gemini entirely (faster, and it can't answer from outside knowledge).
    if (chunks.length === 0 || topSimilarity < MIN_SIMILARITY) return plainStream(NOT_FOUND_ANSWER);

    const context = chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
    const citations = chunks.map((c, i) => ({
      ref: i + 1,
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex,
      score: c.score,
      text: c.text,
    }));

    const answer = generateAnswerStream(
      SYSTEM_PROMPT,
      `Context:\n${context}\n\nQuestion: ${question}`,
    );
    // Pull the first piece now so a failure still returns a proper error status.
    const first = await answer.next();

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ citations }) + "\n"));
        try {
          if (!first.done) controller.enqueue(encoder.encode(first.value));
          for await (const text of answer) controller.enqueue(encoder.encode(text));
        } catch (err) {
          console.error("Chat stream error:", err);
          controller.enqueue(encoder.encode("\n\n[Answer was interrupted. Please try again.]"));
        }
        controller.close();
      },
    });

    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    console.error("Chat error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to answer question" }, { status: 500 });
  }
}

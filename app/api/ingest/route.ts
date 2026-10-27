import { NextRequest, NextResponse } from "next/server";
import { parsePdfBuffer } from "@/lib/rag/layout-parser";
import { chunkPages } from "@/lib/rag/sentence-chunker";
import { embed, ensureIndexes, getCollection } from "@/lib/rag/hybrid-search";
import { CHUNKING_METHOD, READING_METHOD } from "@/lib/rag/hybrid-search";
import type { ChunkMeta, ChunkPayload } from "@/lib/rag/hybrid-search";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No PDF file provided (field: file)" }, { status: 400 });
    }

    const pages = await parsePdfBuffer(Buffer.from(await file.arrayBuffer()));

    const payloads: (ChunkPayload & ChunkMeta)[] = [];
    for (const chunk of chunkPages(pages)) {
      payloads.push({
        text: chunk.text,
        pageNumber: chunk.pageNumber,
        chunkIndex: payloads.length,
        fileName: file.name,
        readingMethod: READING_METHOD,
        chunkingMethod: CHUNKING_METHOD,
        sentenceCount: chunk.sentenceCount,
        overlapSentences: chunk.overlapSentences,
        charLength: chunk.text.length,
      });
    }

    if (payloads.length === 0) {
      return NextResponse.json({ error: "No text could be extracted from the PDF" }, { status: 400 });
    }

    const vectors = await embed(payloads.map((p) => p.text));
    await ensureIndexes();

    const col = await getCollection();
    // Replace any previously ingested document so re-uploads don't duplicate chunks.
    await col.deleteMany({});
    await col.insertMany(payloads.map((payload, i) => ({ ...payload, embedding: vectors[i] })));

    return NextResponse.json({ success: true, pages: pages.length, chunks: payloads.length });
  } catch (err) {
    console.error("Ingest error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to ingest PDF" }, { status: 500 });
  }
}

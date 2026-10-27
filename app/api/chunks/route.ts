import { NextResponse } from "next/server";
import { getCollection } from "@/lib/rag/hybrid-search";

export async function GET() {
  try {
    const col = await getCollection();
    const chunks = await col
      .find({}, { projection: { embedding: 0 } })
      .sort({ chunkIndex: 1 })
      .toArray();
    return NextResponse.json({
      chunks: chunks.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })),
    });
  } catch (err) {
    console.error("Chunks error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load chunks" },
      { status: 500 },
    );
  }
}

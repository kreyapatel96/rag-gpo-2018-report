"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ChunkMeta, ChunkPayload } from "@/lib/rag/hybrid-search";

type StoredChunk = ChunkPayload & ChunkMeta & { id: string };

export default function ChunksPage() {
  const [chunks, setChunks] = useState<StoredChunk[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<number | "all">("all");

  useEffect(() => {
    fetch("/api/chunks")
      .then(async (res) => {
        const data = await res.json();
        if (res.ok) setChunks(data.chunks);
        else setError(data.error ?? "Failed to load chunks");
      })
      .catch(() => setError("Failed to load chunks"))
      .finally(() => setLoading(false));
  }, []);

  const pages = useMemo(
    () => [...new Set(chunks.map((c) => c.pageNumber))].sort((a, b) => a - b),
    [chunks],
  );
  const visible = page === "all" ? chunks : chunks.filter((c) => c.pageNumber === page);
  const first = chunks[0];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Stored chunks</h1>
        <Link href="/" className="text-sm underline">
          Back to upload &amp; chat
        </Link>
      </div>

      {loading && <p>Loading...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && chunks.length === 0 && <p>No chunks yet. Ingest a PDF first.</p>}

      {first && (
        <section className="rounded-lg border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div>
            <b>File:</b> {first.fileName ?? "unknown"}
          </div>
          <div>
            <b>Reading method:</b> {first.readingMethod ?? "n/a (ingested before methods were recorded)"}
          </div>
          <div>
            <b>Chunking method:</b> {first.chunkingMethod ?? "n/a"}
          </div>
          <div>
            <b>Total:</b> {chunks.length} chunks across {pages.length} pages
          </div>
        </section>
      )}

      {pages.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {(["all", ...pages] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={`rounded border px-3 py-1 text-sm ${
                page === p
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "border-zinc-300 dark:border-zinc-700"
              }`}
            >
              {p === "all" ? "All pages" : `Page ${p}`}
            </button>
          ))}
        </div>
      )}

      {visible.map((c) => (
        <article key={c.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>Chunk #{c.chunkIndex}</span>
            <span>Page {c.pageNumber}</span>
            <span>{c.charLength ?? c.text.length} chars</span>
            {c.sentenceCount !== undefined && <span>{c.sentenceCount} sentences</span>}
            {c.overlapSentences !== undefined && (
              <span>
                {c.overlapSentences > 0
                  ? `first ${c.overlapSentences} sentences overlap previous chunk`
                  : "no overlap (first chunk)"}
              </span>
            )}
          </div>
          <p className="text-sm">{c.text}</p>
        </article>
      ))}
    </main>
  );
}

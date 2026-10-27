"use client";

import Link from "next/link";
import { useState } from "react";

interface Citation {
  ref: number;
  pageNumber: number;
  chunkIndex: number;
  score: number;
  text: string;
}

interface ChatResponse {
  answer: string;
  citations: Citation[];
}

/** Reads the streamed reply: first line = citations JSON, then the answer text. */
async function readChatStream(
  res: Response,
  onUpdate: (r: ChatResponse) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let citations: Citation[] | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    if (citations === null) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        citations = (JSON.parse(buffer.slice(0, newline)) as { citations: Citation[] }).citations;
        buffer = buffer.slice(newline + 1);
      }
    }
    if (citations !== null) onUpdate({ answer: buffer, citations });
    if (done) break;
  }
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploading, setUploading] = useState(false);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<ChatResponse | null>(null);
  const [error, setError] = useState("");

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setUploadStatus("");
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body });
      const data = await res.json();
      setUploadStatus(
        res.ok
          ? `Ingested ${data.pages} pages into ${data.chunks} chunks.`
          : `Error: ${data.error}`,
      );
    } catch {
      setUploadStatus("Error: upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (res.ok) await readChatStream(res, setResult);
      else setError((await res.json()).error ?? "Request failed.");
    } catch {
      setError("Request failed.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pipeline 1: Layout-Aware RAG</h1>
        <Link href="/chunks" className="text-sm underline">
          View chunks
        </Link>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="font-medium">1. Upload PDF</h2>
        <form onSubmit={handleUpload} className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="submit"
            disabled={!file || uploading}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {uploading ? "Ingesting..." : "Ingest"}
          </button>
        </form>
        {uploadStatus && <p className="text-sm">{uploadStatus}</p>}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="font-medium">2. Ask a question</h2>
        <form onSubmit={handleAsk} className="flex gap-3">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about the document..."
            className="flex-1 rounded border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={!question.trim() || asking}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {asking ? "Thinking..." : "Ask"}
          </button>
        </form>
        {error && <p className="text-sm text-red-600">{error}</p>}

        {result && (
          <div className="flex flex-col gap-4">
            <p className="whitespace-pre-wrap">{result.answer}</p>
            {result.citations.length > 0 && !result.answer.trim().startsWith("I could not find") && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Context passages</h3>
              {result.citations.map((c) => (
                <div
                  key={c.ref}
                  className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800"
                >
                  <div className="mb-1 text-xs text-zinc-500">
                    [{c.ref}] page {c.pageNumber} · chunk {c.chunkIndex} · RRF {c.score.toFixed(4)}
                  </div>
                  {c.text}
                </div>
              ))}
            </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

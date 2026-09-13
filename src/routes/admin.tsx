import { createFileRoute } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { DemoGate } from "@/components/demo-gate";
import { Button } from "@/components/ui/button";
import {
  createTagBatch,
  downloadAdminBatchPdf,
  downloadAdminTagPng,
  login,
  type ApiTagBatch,
} from "@/lib/core-api";

export const Route = createFileRoute("/admin")({ component: AdminTags });

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function AdminTags() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [categoryKey, setCategory] = useState("medical");
  const [form, setForm] = useState("band");
  const [quantity, setQuantity] = useState(10);
  const [batch, setBatch] = useState<ApiTagBatch | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => () => previewUrl && URL.revokeObjectURL(previewUrl), [previewUrl]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    try {
      setToken(await login(email, password));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Login failed");
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const nextBatch = await createTagBatch(token, { categoryKey, form, quantity });
      const png = await downloadAdminTagPng(token, nextBatch.codes[0]!);
      setPreviewUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(png);
      });
      setBatch(nextBatch);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Batch creation failed");
    }
  }

  async function downloadPdf() {
    if (!batch) return;
    try {
      triggerDownload(await downloadAdminBatchPdf(token, batch.id), `${batch.batchCode}-print.pdf`);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "PDF download failed");
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <DemoGate />
      <h1 className="mt-6 text-3xl font-bold">Admin tag batches</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Create blank stock only. Assignment and activation are separate lifecycle steps.
      </p>
      {!token ? (
        <form onSubmit={signIn} className="mt-6 grid gap-3">
          <input
            placeholder="Admin email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button>Sign in</Button>
        </form>
      ) : (
        <form onSubmit={create} className="mt-6 grid gap-3">
          <select value={categoryKey} onChange={(event) => setCategory(event.target.value)}>
            <option value="medical">Medical</option>
            <option value="elderly">Elderly</option>
            <option value="kids">Kids</option>
          </select>
          <select value={form} onChange={(event) => setForm(event.target.value)}>
            <option value="band">Band</option>
            <option value="sticker">Sticker</option>
            <option value="card">Card</option>
          </select>
          <input
            type="number"
            min="1"
            max="500"
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
          />
          <Button>Create blank batch</Button>
        </form>
      )}
      {error && <p className="mt-3 text-destructive">{error}</p>}
      {batch && (
        <section className="mt-6">
          <p>
            Batch {batch.batchCode}: {batch.codes.length} blank tags.
          </p>
          {previewUrl && (
            <img className="mt-4 max-w-xs" src={previewUrl} alt="Sample blank tag QR" />
          )}
          <p className="mt-2 font-mono">{batch.codes[0]}</p>
          <Button className="mt-4" type="button" onClick={downloadPdf}>
            Download A4 print PDF
          </Button>
        </section>
      )}
    </main>
  );
}

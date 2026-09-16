import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { RouteConfigBuilder } from "@/components/route-config-builder";
import { DemoGate } from "@/components/demo-gate";
import { Button } from "@/components/ui/button";
import {
  CoreApiError,
  createTagBatch,
  downloadAdminBatchPdf,
  downloadAdminTagPng,
  login,
  type ApiTagBatch,
} from "@/lib/core-api";

export const Route = createFileRoute("/admin")({ component: AdminArea });

type AdminSection = "tag-batches" | "route-config";
type JwtRoleHint = "company_admin" | "guardian" | "staff" | "distributor" | null;

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function jwtRoleHint(token: string): JwtRoleHint {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      role?: JwtRoleHint;
    };
    return decoded.role ?? null;
  } catch {
    return null;
  }
}

function adminErrorMessage(error: unknown): string {
  if (!(error instanceof CoreApiError)) {
    return "The request could not be completed. Check the connection and try again.";
  }
  switch (error.status) {
    case 0:
      return error.message;
    case 401:
      return "Your session is no longer valid. Sign in again.";
    case 403:
      return "You do not have company-admin access. No configuration data was loaded.";
    case 404:
      return "That configuration resource is unavailable.";
    case 409:
      return error.message;
    default:
      if (error.status >= 500) {
        return `The Core API is unavailable (status ${error.status}). Check the connection and try again.`;
      }
      return error.message;
  }
}

function AdminArea() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [section, setSection] = useState<AdminSection>("tag-batches");
  const [loginError, setLoginError] = useState("");
  const roleHint = token ? jwtRoleHint(token) : null;

  async function signIn(event: FormEvent) {
    event.preventDefault();
    try {
      setToken(await login(email, password));
      setPassword("");
      setLoginError("");
    } catch (failure) {
      setLoginError(adminErrorMessage(failure));
    }
  }

  function signOut() {
    queryClient.clear();
    setToken("");
    setSection("tag-batches");
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <DemoGate />
      <header className="mt-6">
        <p className="text-sm font-bold uppercase tracking-wide text-category">SafetySpell admin</p>
        <h1 className="mt-1 text-3xl font-bold">Owner operations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Local Core API only. Server-side company-admin authorization is required for every
          configuration request.
        </p>
      </header>
      {!token ? (
        <form onSubmit={signIn} className="mt-6 grid max-w-md gap-3">
          <input
            placeholder="Admin email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            required
          />
          <input
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            required
            minLength={12}
          />
          <Button>Sign in</Button>
          {loginError ? (
            <p className="text-sm font-semibold text-destructive">{loginError}</p>
          ) : null}
        </form>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
            <div>
              <p className="text-sm font-semibold">Role claim: {roleHint ?? "unavailable"}</p>
              <p className="text-xs text-muted-foreground">
                This browser hint controls no access; the first live API request is the authority
                check.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={signOut}>
              Sign out
            </Button>
          </div>
          <nav className="mt-4 flex flex-wrap gap-2" aria-label="Admin sections">
            <Button
              type="button"
              variant={section === "tag-batches" ? "default" : "outline"}
              onClick={() => setSection("tag-batches")}
            >
              Tag batches
            </Button>
            <Button
              type="button"
              variant={section === "route-config" ? "default" : "outline"}
              onClick={() => setSection("route-config")}
            >
              Route configuration
            </Button>
          </nav>
          {section === "tag-batches" ? (
            <TagBatchPanel token={token} />
          ) : (
            <RouteConfigConnection token={token} onReauthenticate={signOut} />
          )}
        </>
      )}
    </main>
  );
}

function RouteConfigConnection({
  token,
  onReauthenticate,
}: {
  token: string;
  onReauthenticate: () => void;
}) {
  return <RouteConfigBuilder token={token} onReauthenticate={onReauthenticate} />;
}

function TagBatchPanel({ token }: { token: string }) {
  const [categoryKey, setCategory] = useState("medical");
  const [form, setForm] = useState("band");
  const [quantity, setQuantity] = useState(10);
  const [batch, setBatch] = useState<ApiTagBatch | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => () => previewUrl && URL.revokeObjectURL(previewUrl), [previewUrl]);

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
      setError(adminErrorMessage(failure));
    }
  }

  async function downloadPdf() {
    if (!batch) return;
    try {
      triggerDownload(await downloadAdminBatchPdf(token, batch.id), `${batch.batchCode}-print.pdf`);
      setError("");
    } catch (failure) {
      setError(adminErrorMessage(failure));
    }
  }

  return (
    <section className="mt-6" aria-labelledby="tag-batches-title">
      <h2 id="tag-batches-title" className="text-xl font-bold">
        Admin tag batches
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Create blank stock only. Assignment and activation are separate lifecycle steps.
      </p>
      <form onSubmit={create} className="mt-6 grid max-w-md gap-3">
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
      {error ? <p className="mt-3 text-sm font-semibold text-destructive">{error}</p> : null}
      {batch ? (
        <section className="mt-6">
          <p>
            Batch {batch.batchCode}: {batch.codes.length} blank tags.
          </p>
          {previewUrl ? (
            <img className="mt-4 max-w-xs" src={previewUrl} alt="Sample blank tag QR" />
          ) : null}
          <p className="mt-2 font-mono">{batch.codes[0]}</p>
          <Button className="mt-4" type="button" onClick={downloadPdf}>
            Download A4 print PDF
          </Button>
        </section>
      ) : null}
    </section>
  );
}

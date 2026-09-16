import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { DemoGate } from "@/components/demo-gate";
import { Button } from "@/components/ui/button";
import {
  CoreApiError,
  createTagBatch,
  downloadAdminBatchPdf,
  downloadAdminTagPng,
  listRouteConfigRoutes,
  listRouteConfigTenantRoles,
  login,
  routeConfigQueryKeys,
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
  const routes = useQuery({
    queryKey: routeConfigQueryKeys.routes(token),
    queryFn: () => listRouteConfigRoutes(token),
    retry: false,
  });
  const tenantRoles = useQuery({
    queryKey: routeConfigQueryKeys.tenantRoles(token),
    queryFn: () => listRouteConfigTenantRoles(token),
    retry: false,
  });
  const errors = [routes.error, tenantRoles.error].filter((error): error is Error =>
    Boolean(error),
  );
  const uniqueErrors = Array.from(new Map(errors.map((error) => [error.message, error])).values());
  const unauthorized = errors.some(
    (error) => error instanceof CoreApiError && error.status === 401,
  );
  const forbidden = errors.some((error) => error instanceof CoreApiError && error.status === 403);

  return (
    <section className="mt-6 rounded-lg border p-5" aria-labelledby="route-config-title">
      <h2 id="route-config-title" className="text-xl font-bold">
        Route configuration connection
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Slice A verifies live configuration reads only. Route, stage, hop, and role forms arrive in
        Slice B; no configuration can be changed from this panel.
      </p>
      {routes.isPending || tenantRoles.isPending ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading live admin configuration…</p>
      ) : null}
      {uniqueErrors.map((error) => (
        <div key={error.message} className="mt-4 rounded-md border border-destructive/40 p-3">
          <p className="text-sm font-semibold text-destructive">{adminErrorMessage(error)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {unauthorized ? (
              <Button type="button" size="sm" onClick={onReauthenticate}>
                Sign in again
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void routes.refetch();
                  void tenantRoles.refetch();
                }}
              >
                Retry live request
              </Button>
            )}
          </div>
        </div>
      ))}
      {!errors.length && !routes.isPending && !tenantRoles.isPending ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md bg-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Routes
            </p>
            <p className="mt-1 text-2xl font-bold">{routes.data?.length ?? 0}</p>
            <p className="text-sm text-muted-foreground">
              {routes.data?.length ? "Live server response loaded." : "No routes configured yet."}
            </p>
          </div>
          <div className="rounded-md bg-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Tenant roles
            </p>
            <p className="mt-1 text-2xl font-bold">{tenantRoles.data?.length ?? 0}</p>
            <p className="text-sm text-muted-foreground">Live server response loaded.</p>
          </div>
        </div>
      ) : null}
      {forbidden ? (
        <p className="mt-4 text-sm text-muted-foreground">
          The backend denied this request. No route or tenant-role data is shown.
        </p>
      ) : null}
    </section>
  );
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

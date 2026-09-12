import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CircleUserRound,
  Home,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DemoGate } from "@/components/demo-gate";
import {
  type ApiGuardianField,
  coreApiUrl,
  CoreApiError,
  listFields,
  listWards,
  login,
  setVisibility,
  writeField,
} from "@/lib/core-api";

const valuesByKey = {
  age_band: [
    ["child", "Child"],
    ["teen", "Teen"],
    ["adult", "Adult"],
    ["senior", "Senior"],
  ],
  primary_language: [
    ["hi", "Hindi"],
    ["en", "English"],
  ],
} as const;

const categoryClass = (category?: string) =>
  category === "deaf_mute"
    ? "deaf-mute"
    : category === "epilepsy_cardiac"
      ? "epilepsy-cardiac"
      : category;

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "SafetySpell Guardian — demo app" },
      { name: "description", content: "Demo-only guardian PWA shell." },
    ],
  }),
  component: GuardianApp,
});

function GuardianApp() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [selectedWardId, setSelectedWardId] = useState<string | null>(null);
  const [pendingFieldId, setPendingFieldId] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const wards = useQuery({
    queryKey: ["guardian-wards", token],
    queryFn: () => listWards(token ?? ""),
    enabled: Boolean(token),
    retry: false,
  });
  const selectedWard = wards.data?.find((ward) => ward.id === selectedWardId) ?? wards.data?.[0];
  const fields = useQuery({
    queryKey: ["guardian-fields", token, selectedWard?.id],
    queryFn: () => listFields(token ?? "", selectedWard?.id ?? ""),
    enabled: Boolean(token && selectedWard),
    retry: false,
  });

  useEffect(() => {
    if (!selectedWardId && wards.data?.[0]) setSelectedWardId(wards.data[0].id);
  }, [selectedWardId, wards.data]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginPending(true);
    setLoginError(null);
    try {
      setToken(await login(email, password));
      setPassword("");
    } catch (error) {
      setLoginError(message(error));
    } finally {
      setLoginPending(false);
    }
  }

  async function updateField(field: ApiGuardianField, value: string) {
    if (!token || !selectedWard) return;
    setPendingFieldId(field.catalogId);
    setUpdateError(null);
    try {
      await writeField(token, selectedWard.id, field.catalogId, value);
      await queryClient.invalidateQueries({
        queryKey: ["guardian-fields", token, selectedWard.id],
      });
    } catch (error) {
      setUpdateError(message(error));
    } finally {
      setPendingFieldId(null);
    }
  }

  async function updateVisibility(field: ApiGuardianField) {
    if (!token || !selectedWard) return;
    setPendingFieldId(field.catalogId);
    setUpdateError(null);
    try {
      await setVisibility(
        token,
        selectedWard.id,
        field.catalogId,
        field.visibility === "public" ? "private" : "public",
      );
      await queryClient.invalidateQueries({
        queryKey: ["guardian-fields", token, selectedWard.id],
      });
    } catch (error) {
      setUpdateError(message(error));
    } finally {
      setPendingFieldId(null);
    }
  }

  if (!coreApiUrl) return <UnconfiguredApp />;

  return (
    <div
      className="min-h-dvh bg-app text-foreground"
      data-category={categoryClass(selectedWard?.category) ?? "elderly"}
    >
      <DemoGate />
      <main className="mx-auto min-h-[calc(100dvh-40px)] w-full max-w-3xl px-5 py-7 pb-28">
        <header>
          <p className="text-sm font-bold uppercase tracking-wide text-category">
            SafetySpell · guardian PWA
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold">Guardian access</h1>
          <p className="mt-2 text-base text-muted-foreground">
            Local Core API mode. Only age band and primary language are available in this prototype.
          </p>
        </header>
        {!token ? (
          <LoginForm
            email={email}
            password={password}
            pending={loginPending}
            error={loginError}
            onEmail={setEmail}
            onPassword={setPassword}
            onSubmit={signIn}
          />
        ) : (
          <GuardianWorkspace
            wards={wards.data ?? []}
            selectedWardId={selectedWard?.id}
            onSelectWard={setSelectedWardId}
            fields={fields.data ?? []}
            fieldsPending={fields.isPending}
            fieldsError={fields.error}
            pendingFieldId={pendingFieldId}
            updateError={updateError}
            onUpdateField={updateField}
            onUpdateVisibility={updateVisibility}
            onSignOut={() => {
              setToken(null);
              setSelectedWardId(null);
              queryClient.clear();
            }}
          />
        )}
      </main>
      <PreviewNav />
    </div>
  );
}

function LoginForm({
  email,
  password,
  pending,
  error,
  onEmail,
  onPassword,
  onSubmit,
}: {
  email: string;
  password: string;
  pending: boolean;
  error: string | null;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card className="mt-7 border-category/30">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Use an existing local guardian account. Credentials are held only for this browser
          session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <label className="grid gap-1 text-sm font-semibold">
            Email
            <input
              className="h-11 rounded-md border border-input bg-background px-3"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmail(event.target.value)}
              required
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Password
            <input
              className="h-11 rounded-md border border-input bg-background px-3"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => onPassword(event.target.value)}
              required
              minLength={12}
            />
          </label>
          {error ? <p className="text-sm font-semibold text-destructive">{error}</p> : null}
          <Button type="submit" size="touch" disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{" "}
            {pending ? "Signing in" : "SIGN IN TO LOCAL API"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function GuardianWorkspace({
  wards,
  selectedWardId,
  onSelectWard,
  fields,
  fieldsPending,
  fieldsError,
  pendingFieldId,
  updateError,
  onUpdateField,
  onUpdateVisibility,
  onSignOut,
}: {
  wards: Array<{ id: string; name: string; category: string }>;
  selectedWardId?: string;
  onSelectWard: (id: string) => void;
  fields: ApiGuardianField[];
  fieldsPending: boolean;
  fieldsError: Error | null;
  pendingFieldId: string | null;
  updateError: string | null;
  onUpdateField: (field: ApiGuardianField, value: string) => Promise<void>;
  onUpdateVisibility: (field: ApiGuardianField) => Promise<void>;
  onSignOut: () => void;
}) {
  return (
    <>
      <section className="mt-7" aria-labelledby="wards-title">
        <div className="flex items-center justify-between gap-4">
          <h2 id="wards-title" className="text-xl font-bold">
            Your wards
          </h2>
          <Button variant="outline" size="sm" type="button" onClick={onSignOut}>
            <LogOut /> Sign out
          </Button>
        </div>
        {wards.length ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {wards.map((ward) => (
              <button
                key={ward.id}
                type="button"
                onClick={() => onSelectWard(ward.id)}
                className={`rounded-lg border p-4 text-left ${ward.id === selectedWardId ? "border-category bg-category-soft" : "border-border"}`}
              >
                <p className="font-bold">{ward.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {ward.category.replaceAll("_", " ")}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-muted-foreground">
            No active wards are available for this guardian.
          </p>
        )}
      </section>
      <Card className="mt-7 border-category/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="text-category" />
            Minimal private profile and consent
          </CardTitle>
          <CardDescription>
            Values are saved to the local API. Public release remains unavailable until a clinical
            reviewer has approved the catalog field.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {fieldsPending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> Loading fields
            </p>
          ) : null}
          {fieldsError ? (
            <p className="text-sm font-semibold text-destructive">{message(fieldsError)}</p>
          ) : null}
          {updateError ? (
            <p className="mb-3 text-sm font-semibold text-destructive">{updateError}</p>
          ) : null}
          <div className="grid gap-5">
            {fields.map((field) => (
              <FieldEditor
                key={field.catalogId}
                field={field}
                pending={pendingFieldId === field.catalogId}
                onUpdateField={onUpdateField}
                onUpdateVisibility={onUpdateVisibility}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function FieldEditor({
  field,
  pending,
  onUpdateField,
  onUpdateVisibility,
}: {
  field: ApiGuardianField;
  pending: boolean;
  onUpdateField: (field: ApiGuardianField, value: string) => Promise<void>;
  onUpdateVisibility: (field: ApiGuardianField) => Promise<void>;
}) {
  const options = valuesByKey[field.key];
  if (!options) return null;
  const current = typeof field.value === "string" ? field.value : "";
  return (
    <div className="rounded-lg border border-border p-4">
      <label className="grid gap-2 text-sm font-bold">
        {field.label}
        <select
          className="h-11 rounded-md border border-input bg-background px-3"
          value={current}
          disabled={pending}
          onChange={(event) => {
            void onUpdateField(field, event.target.value);
          }}
        >
          <option value="">Choose {field.label.toLowerCase()}</option>
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {field.visibility === "public"
            ? "Publicly released"
            : field.publicReleaseEligible
              ? "Private"
              : "Private — catalog review pending"}
        </p>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={pending || !current || !field.publicReleaseEligible}
          onClick={() => {
            void onUpdateVisibility(field);
          }}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
          {field.visibility === "public" ? "MAKE PRIVATE" : "RELEASE PUBLICLY"}
        </Button>
      </div>
    </div>
  );
}

function UnconfiguredApp() {
  return (
    <div className="min-h-dvh bg-app text-foreground">
      <DemoGate />
      <main className="mx-auto w-full max-w-3xl px-5 py-7">
        <h1 className="font-display text-3xl font-bold">Guardian access</h1>
        <p className="mt-3 text-muted-foreground">
          This build has no Core API URL. Configure <code>VITE_CORE_API_URL</code> for the local API
          before signing in.
        </p>
      </main>
      <PreviewNav />
    </div>
  );
}

function PreviewNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 mx-auto grid h-20 max-w-3xl grid-cols-4 border-t border-border bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      aria-label="Guardian app navigation preview"
    >
      <span className="flex flex-col items-center justify-center gap-1 text-category">
        <Home className="size-5" />
        Home
      </span>
      <span className="flex flex-col items-center justify-center gap-1 text-muted-foreground">
        <UsersRound className="size-5" />
        Wards
      </span>
      <span className="flex flex-col items-center justify-center gap-1 text-muted-foreground">
        <CircleUserRound className="size-5" />
        Profile
      </span>
      <span className="flex flex-col items-center justify-center gap-1 text-muted-foreground">
        <Bell className="size-5" />
        Alerts
      </span>
    </nav>
  );
}

function message(error: unknown): string {
  return error instanceof CoreApiError || error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CircleUserRound,
  History,
  Home,
  LoaderCircle,
  LogOut,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DemoGate } from "@/components/demo-gate";
import { WardTagQr } from "@/components/ward-tag-qr";
import { conditionFlagDefinitions, knownConditionFlagKeys } from "@/lib/condition-flags";
import { isProduction } from "@/lib/env";
import {
  type ApiConsentAuditEntry,
  type ApiGuardianField,
  type ApiWardTag,
  activateTag,
  claimTag,
  coreApiUrl,
  CoreApiError,
  getConsentAudit,
  listFields,
  listTags,
  listWards,
  login,
  setVisibility,
  withdrawPublicRelease,
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
  blood_group: [
    ["A+", "A+"],
    ["A-", "A-"],
    ["B+", "B+"],
    ["B-", "B-"],
    ["O+", "O+"],
    ["O-", "O-"],
    ["AB+", "AB+"],
    ["AB-", "AB-"],
    ["Unknown", "Unknown"],
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
  const tags = useQuery({
    queryKey: ["guardian-tags", token, selectedWard?.id],
    queryFn: () => listTags(token ?? "", selectedWard?.id ?? ""),
    enabled: Boolean(token && selectedWard),
    retry: false,
  });
  const consentAudit = useQuery({
    queryKey: ["guardian-consent-audit", selectedWard?.id],
    queryFn: () => getConsentAudit(token ?? "", selectedWard?.id ?? ""),
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

  async function updateField(field: ApiGuardianField, value: unknown) {
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
      await queryClient.invalidateQueries({
        queryKey: ["guardian-consent-audit", selectedWard.id],
      });
    } catch (error) {
      setUpdateError(message(error));
    } finally {
      setPendingFieldId(null);
    }
  }

  async function withdrawAllConsent() {
    if (!token || !selectedWard)
      throw new Error("Select a ward before withdrawing public release.");
    const result = await withdrawPublicRelease(token, selectedWard.id);
    await queryClient.invalidateQueries({
      queryKey: ["guardian-fields", token, selectedWard.id],
    });
    await queryClient.invalidateQueries({
      queryKey: ["guardian-consent-audit", selectedWard.id],
    });
    return result;
  }

  async function claimWardTag(tagCode: string, pin: string) {
    if (!token || !selectedWard) throw new Error("Select a ward before claiming a tag.");
    const result = await claimTag(token, selectedWard.id, tagCode, pin);
    await queryClient.invalidateQueries({ queryKey: ["guardian-tags", token, selectedWard.id] });
    return result;
  }

  async function activateWardTag(tagCode: string) {
    if (!token || !selectedWard) throw new Error("Select a ward before activating a tag.");
    const result = await activateTag(token, selectedWard.id, tagCode);
    await queryClient.invalidateQueries({ queryKey: ["guardian-tags", token, selectedWard.id] });
    return result;
  }

  if (!coreApiUrl) return <UnconfiguredApp />;

  return (
    <div
      className="min-h-dvh bg-app text-foreground"
      data-category={categoryClass(selectedWard?.category) ?? "elderly"}
    >
      <DemoGate />
      <main
        className={`mx-auto min-h-[calc(100dvh-40px)] w-full max-w-3xl px-5 py-7 ${isProduction() ? "pb-10" : "pb-28"}`}
      >
        <header>
          <p className="text-sm font-bold uppercase tracking-wide text-category">
            SafetySpell · guardian PWA
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold">Guardian access</h1>
          <p className="mt-2 text-base text-muted-foreground">
            {isProduction()
              ? "Manage profile fields and emergency public consent for your wards."
              : "Local Core API mode. Profile fields, condition flags, and condition notes are available in this prototype."}
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
            selectedWardLabel={selectedWard?.name ?? ""}
            onSelectWard={setSelectedWardId}
            fields={fields.data ?? []}
            fieldsPending={fields.isPending}
            fieldsError={fields.error}
            tags={tags.data ?? []}
            tagsPending={tags.isPending}
            tagsError={tags.error}
            pendingFieldId={pendingFieldId}
            updateError={updateError}
            onUpdateField={updateField}
            onUpdateVisibility={updateVisibility}
            onClaimTag={claimWardTag}
            onActivateTag={activateWardTag}
            auditEntries={consentAudit.data ?? []}
            auditPending={consentAudit.isPending}
            auditError={consentAudit.error}
            onWithdrawAllConsent={withdrawAllConsent}
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
  selectedWardLabel,
  onSelectWard,
  fields,
  fieldsPending,
  fieldsError,
  tags,
  tagsPending,
  tagsError,
  pendingFieldId,
  updateError,
  onUpdateField,
  onUpdateVisibility,
  onClaimTag,
  onActivateTag,
  auditEntries,
  auditPending,
  auditError,
  onWithdrawAllConsent,
  onSignOut,
}: {
  wards: Array<{ id: string; name: string; category: string }>;
  selectedWardId?: string;
  selectedWardLabel: string;
  onSelectWard: (id: string) => void;
  fields: ApiGuardianField[];
  fieldsPending: boolean;
  fieldsError: Error | null;
  tags: ApiWardTag[];
  tagsPending: boolean;
  tagsError: Error | null;
  pendingFieldId: string | null;
  updateError: string | null;
  onUpdateField: (field: ApiGuardianField, value: unknown) => Promise<void>;
  onUpdateVisibility: (field: ApiGuardianField) => Promise<void>;
  onClaimTag: (tagCode: string, pin: string) => Promise<{ code: string }>;
  onActivateTag: (tagCode: string) => Promise<{ code: string; status: "active" }>;
  auditEntries: ApiConsentAuditEntry[];
  auditPending: boolean;
  auditError: Error | null;
  onWithdrawAllConsent: () => Promise<unknown>;
  onSignOut: () => void;
}) {
  const activeTags = tags.filter((tag) => tag.status === "active");
  const publicFieldCount = fields.filter((field) => field.visibility === "public").length;
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
            Values are saved privately to the local API. Nothing is public until you release a
            field. Released fields appear on the public scan; free-text entries are stripped of
            links and formatting on save.
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
      <ConsentWithdrawalPanel
        disabled={!selectedWardId}
        publicFieldCount={publicFieldCount}
        onWithdraw={onWithdrawAllConsent}
      />
      <TagLifecyclePanel
        assignedTags={tags.filter((tag) => tag.status === "assigned")}
        disabled={!selectedWardId}
        onClaimTag={onClaimTag}
        onActivateTag={onActivateTag}
      />
      <Card className="mt-7 border-category/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="text-category" />
            Rescue ID tags
          </CardTitle>
          <CardDescription>
            Generate a printable QR for a tag. It opens that tag&apos;s public scan page and encodes
            no personal data. The backup code prints underneath for a scratched QR.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WardTagQr
            wardLabel={selectedWardLabel}
            tags={activeTags}
            pending={tagsPending}
            error={tagsError}
          />
        </CardContent>
      </Card>
      <ConsentAuditTimeline auditEntries={auditEntries} pending={auditPending} error={auditError} />
    </>
  );
}

export function TagLifecyclePanel({
  assignedTags,
  disabled,
  onClaimTag,
  onActivateTag,
}: {
  assignedTags: ApiWardTag[];
  disabled: boolean;
  onClaimTag: (tagCode: string, pin: string) => Promise<{ code: string }>;
  onActivateTag: (tagCode: string) => Promise<{ code: string; status: "active" }>;
}) {
  const [tagCode, setTagCode] = useState("");
  const [pin, setPin] = useState("");
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function claim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingCode("claim");
    setError(null);
    setNotice(null);
    try {
      const result = await onClaimTag(tagCode, pin);
      setTagCode("");
      setPin("");
      setNotice(
        `${result.code} is claimed. Complete activation only after a real public field is released.`,
      );
    } catch (failure) {
      setError(message(failure));
    } finally {
      setPendingCode(null);
    }
  }

  async function activate(code: string) {
    setPendingCode(code);
    setError(null);
    setNotice(null);
    try {
      const result = await onActivateTag(code);
      setNotice(
        `${result.code} is active. Its released profile fields are now available on the public scan.`,
      );
    } catch (failure) {
      setError(message(failure));
    } finally {
      setPendingCode(null);
    }
  }

  return (
    <Card className="mt-7 border-category/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="text-category" /> Claim and activate a tag
        </CardTitle>
        <CardDescription>
          Claim needs the printed tag code and one-time activation PIN. Activation is
          server-checked: at least one real profile field must already be publicly released.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <form className="grid gap-3" onSubmit={claim}>
          <label className="grid gap-1 text-sm font-semibold">
            Tag code
            <input
              className="h-11 rounded-md border border-input bg-background px-3 font-mono uppercase"
              value={tagCode}
              onChange={(event) => setTagCode(event.target.value.toUpperCase())}
              placeholder="SS-XXXX-XXXX"
              autoCapitalize="characters"
              required
              disabled={disabled || pendingCode !== null}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            One-time activation PIN
            <input
              className="h-11 rounded-md border border-input bg-background px-3 font-mono uppercase"
              value={pin}
              onChange={(event) => setPin(event.target.value.toUpperCase())}
              autoCapitalize="characters"
              required
              disabled={disabled || pendingCode !== null}
            />
          </label>
          <Button type="submit" size="touch" disabled={disabled || pendingCode !== null}>
            {pendingCode === "claim" ? <LoaderCircle className="animate-spin" /> : <QrCode />}
            {pendingCode === "claim" ? "Claiming tag" : "CLAIM TAG"}
          </Button>
        </form>
        {error ? <p className="text-sm font-semibold text-destructive">{error}</p> : null}
        {notice ? <p className="text-sm font-semibold text-category">{notice}</p> : null}
        {assignedTags.length ? (
          <section aria-labelledby="pending-activation-title">
            <h3 id="pending-activation-title" className="font-semibold">
              Ready to activate
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              These tags are assigned but not public. Activate only after the profile has a released
              field.
            </p>
            <div className="mt-3 grid gap-3">
              {assignedTags.map((tag) => (
                <div
                  key={tag.code}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <span className="font-mono text-sm">{tag.code}</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pendingCode !== null}
                    onClick={() => void activate(tag.code)}
                  >
                    {pendingCode === tag.code ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <ShieldCheck />
                    )}
                    {pendingCode === tag.code ? "Activating" : "ACTIVATE"}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

export const readableFieldLabels: Record<string, string> = {
  age_band: "Age band",
  primary_language: "Primary language",
  blood_group: "Blood group",
  allergy: "Allergies",
  condition_flags: "Condition flags",
  condition_notes: "Condition notes",
};

export function formatFieldKey(key?: string): string {
  if (!key) return "All public fields";
  return (
    readableFieldLabels[key] ??
    key.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

export function ConsentWithdrawalPanel({
  disabled,
  publicFieldCount,
  onWithdraw,
}: {
  disabled: boolean;
  publicFieldCount: number;
  onWithdraw: () => Promise<unknown>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleWithdraw() {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await onWithdraw();
      setConfirmed(false);
      setNotice(
        "All public disclosures have been withdrawn. Emergency scan pages now show the neutral unavailable response.",
      );
    } catch (failure) {
      setError(message(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card
      className="mt-7 border-destructive/40 bg-destructive/5"
      data-testid="consent-withdrawal-panel"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <ShieldAlert className="size-5" />
          Withdraw all public releases
        </CardTitle>
        <CardDescription>
          Instantly and atomically revoke every publicly released field for this ward. Once
          withdrawn, public scan pages display only the neutral unavailable response until you
          explicitly re-release fields.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {publicFieldCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            No fields are currently released publicly for this ward. Emergency scans already show
            the neutral unavailable response.
          </p>
        ) : (
          <p className="text-sm font-medium text-destructive">
            Currently {publicFieldCount} {publicFieldCount === 1 ? "field is" : "fields are"}{" "}
            publicly visible on rescue ID scans.
          </p>
        )}

        <label className="flex items-start gap-2 text-sm">
          <input
            id="withdraw-confirm-checkbox"
            type="checkbox"
            className="mt-0.5 rounded border-input"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={disabled || pending}
          />
          <span>
            I understand that withdrawing public release removes all emergency information from
            public view immediately.
          </span>
        </label>

        <div>
          <Button
            type="button"
            variant="destructive"
            disabled={disabled || pending || !confirmed}
            onClick={handleWithdraw}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <ShieldAlert />}
            {pending ? "Withdrawing public access…" : "WITHDRAW ALL PUBLIC RELEASES"}
          </Button>
        </div>

        {error ? <p className="text-sm font-semibold text-destructive">{error}</p> : null}
        {notice ? (
          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{notice}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ConsentAuditTimeline({
  auditEntries,
  pending,
  error,
}: {
  auditEntries: ApiConsentAuditEntry[];
  pending: boolean;
  error: Error | null;
}) {
  return (
    <Card className="mt-7 border-category/30" data-testid="consent-audit-timeline">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-5 text-category" />
          Consent & disclosure history
        </CardTitle>
        <CardDescription>
          Immutable append-only record of all visibility and withdrawal actions for this ward.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading consent history…
          </p>
        ) : null}
        {error ? <p className="text-sm font-semibold text-destructive">{message(error)}</p> : null}
        {!pending && !error && auditEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="audit-empty-state">
            No consent modifications recorded for this ward yet.
          </p>
        ) : null}
        {auditEntries.length > 0 ? (
          <div className="grid gap-3">
            {auditEntries.map((entry, index) => {
              const isWithdrawal = entry.eventType === "public_release_withdrawn";
              const isPublic = entry.newVisibility === "public";
              return (
                <div
                  key={`${entry.createdAt}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5 text-sm"
                >
                  <div className="grid gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">
                        {formatFieldKey(entry.fieldKey)}
                      </span>
                      {isWithdrawal ? (
                        <Badge variant="destructive">All public releases withdrawn</Badge>
                      ) : isPublic ? (
                        <Badge className="bg-category text-category-foreground hover:bg-category/90">
                          Released publicly
                        </Badge>
                      ) : (
                        <Badge variant="outline">Set to private</Badge>
                      )}
                    </div>
                    {entry.oldVisibility && entry.newVisibility ? (
                      <p className="text-xs text-muted-foreground">
                        Changed from <span className="font-medium">{entry.oldVisibility}</span> to{" "}
                        <span className="font-medium">{entry.newVisibility}</span>
                      </p>
                    ) : null}
                  </div>
                  <time
                    className="font-mono text-xs text-muted-foreground"
                    dateTime={entry.createdAt}
                  >
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </div>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NotesInput({
  current,
  pending,
  onSave,
  fieldLabel,
}: {
  current: string;
  pending: boolean;
  onSave: (value: string) => Promise<void>;
  fieldLabel: string;
}) {
  const [draft, setDraft] = useState(current);
  useEffect(() => {
    setDraft(current);
  }, [current]);
  return (
    <div className="grid gap-1">
      <textarea
        className="min-h-24 rounded-md border border-input bg-background px-3 py-2 font-normal"
        value={draft}
        disabled={pending}
        placeholder={`One ${fieldLabel.toLowerCase()} point per line`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== current) void onSave(draft);
        }}
      />
      <span className="text-xs font-normal text-muted-foreground">
        One point per line. Links and formatting are stripped on save.
      </span>
    </div>
  );
}

function ConditionFlagsInput({
  current,
  pending,
  onSave,
}: {
  current: unknown;
  pending: boolean;
  onSave: (value: string[]) => Promise<void>;
}) {
  const selected = new Set(knownConditionFlagKeys(current));
  return (
    <fieldset className="grid gap-2 font-normal sm:grid-cols-2">
      <legend className="sr-only">Condition flags</legend>
      {conditionFlagDefinitions.map((flag) => (
        <label key={flag.key} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.has(flag.key)}
            disabled={pending}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(flag.key);
              else next.delete(flag.key);
              void onSave(
                conditionFlagDefinitions
                  .filter((item) => next.has(item.key))
                  .map((item) => item.key),
              );
            }}
          />
          {flag.label}
        </label>
      ))}
    </fieldset>
  );
}

export function FieldEditor({
  field,
  pending,
  onUpdateField,
  onUpdateVisibility,
}: {
  field: ApiGuardianField;
  pending: boolean;
  onUpdateField: (field: ApiGuardianField, value: unknown) => Promise<void>;
  onUpdateVisibility: (field: ApiGuardianField) => Promise<void>;
}) {
  const isFreeText = field.key === "allergy" || field.key === "condition_notes";
  const isConditionFlags = field.key === "condition_flags";
  const options = (valuesByKey as Record<string, ReadonlyArray<readonly [string, string]>>)[
    field.key
  ];
  if (!isFreeText && !isConditionFlags && !options) return null;
  const current = typeof field.value === "string" ? field.value : "";
  const hasValue = isConditionFlags
    ? knownConditionFlagKeys(field.value).length > 0
    : Boolean(current);
  return (
    <div className="rounded-lg border border-border p-4">
      <label className="grid gap-2 text-sm font-bold">
        {field.label}
        {isFreeText ? (
          <NotesInput
            current={current}
            pending={pending}
            fieldLabel={field.label}
            onSave={(value) => onUpdateField(field, value)}
          />
        ) : isConditionFlags ? (
          <ConditionFlagsInput
            current={field.value}
            pending={pending}
            onSave={(value) => onUpdateField(field, value)}
          />
        ) : (
          <select
            className="h-11 rounded-md border border-input bg-background px-3"
            value={current}
            disabled={pending}
            onChange={(event) => {
              void onUpdateField(field, event.target.value);
            }}
          >
            <option value="">Choose {field.label.toLowerCase()}</option>
            {(options ?? []).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {field.visibility === "public"
            ? "Publicly released"
            : field.publicReleaseEligible
              ? "Private"
              : "Private — not public-capable"}
        </p>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={pending || !hasValue || !field.publicReleaseEligible}
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

export function PreviewNav() {
  if (isProduction()) {
    return null;
  }
  return (
    <nav
      data-testid="preview-nav"
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

import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { DemoGate } from "@/components/demo-gate";
import { StageTrackingBoard } from "@/components/stage-tracking-board";
import { Button } from "@/components/ui/button";
import {
  CoreApiError,
  coreApiUrl,
  listStageTrackingBoard,
  login,
  stageTrackingQueryKeys,
  tapStageTrackingTag,
} from "@/lib/core-api";

export const Route = createFileRoute("/operations")({ component: OperationsArea });

type JwtRoleHint = "company_admin" | "guardian" | "staff" | "distributor" | null;

function jwtRoleHint(token: string): JwtRoleHint {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return (JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: JwtRoleHint }).role ?? null;
  } catch {
    return null;
  }
}

function operationsError(error: unknown): string {
  if (!(error instanceof CoreApiError)) return "The request could not be completed. Check the connection and try again.";
  if (error.status === 0) return error.message;
  if (error.status === 401) return "Your session is no longer valid. Sign in again.";
  if (error.status === 403 || error.status === 404)
    return "This operations workspace is unavailable for this account.";
  return error.status >= 500
    ? `The Core API is unavailable (status ${error.status}). Check the connection and try again.`
    : error.message;
}

function OperationsArea() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const roleHint = token ? jwtRoleHint(token) : null;
  const isStaff = roleHint === "staff";
  const board = useQuery({
    queryKey: stageTrackingQueryKeys.board(token),
    queryFn: () => listStageTrackingBoard(token),
    enabled: Boolean(token && isStaff),
    retry: false,
  });
  const tap = useMutation({
    mutationFn: (tagCode: string) => tapStageTrackingTag(token, tagCode),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: stageTrackingQueryKeys.board(token) });
    },
  });

  async function signIn(event: FormEvent) {
    event.preventDefault();
    try {
      setToken(await login(email, password));
      setPassword("");
      setLoginError("");
    } catch (error) {
      setLoginError(operationsError(error));
    }
  }

  function signOut() {
    queryClient.clear();
    setToken("");
    setLoginError("");
  }

  if (!coreApiUrl) {
    return <main className="mx-auto max-w-3xl p-6">The Core API is not configured for this build.</main>;
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <DemoGate />
      <header className="mt-6">
        <p className="text-sm font-bold uppercase tracking-wide text-category">SafetySpell operations</p>
        <h1 className="mt-1 text-3xl font-bold">Stage arrival board</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Internal workflow only. Stage tracking never appears on the public scan.
        </p>
      </header>
      {!token ? (
        <form onSubmit={signIn} className="mt-6 grid max-w-md gap-3">
          <input
            placeholder="Staff email"
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
          {loginError ? <p className="text-sm font-semibold text-destructive">{loginError}</p> : null}
        </form>
      ) : (
        <>
          <div className="mt-6 flex items-center justify-between border-b pb-4">
            <p className="text-sm text-muted-foreground">Server authorization controls access.</p>
            <Button type="button" variant="outline" onClick={signOut}>
              Sign out
            </Button>
          </div>
          {isStaff ? (
            board.isPending ? (
              <p className="mt-6 text-sm text-muted-foreground">Loading your server-authorized board…</p>
            ) : board.error ? (
              <p className="mt-6 text-sm font-semibold text-destructive">{operationsError(board.error)}</p>
            ) : (
              <StageTrackingBoard
                rows={board.data ?? []}
                pendingTagCode={tap.isPending ? tap.variables : null}
                onTap={async (tagCode) => {
                  await tap.mutateAsync(tagCode);
                }}
              />
            )
          ) : (
            <p className="mt-6 rounded-md border p-4 text-sm text-muted-foreground">
              This workspace is available only to staff. No board or tap controls were loaded.
            </p>
          )}
        </>
      )}
    </main>
  );
}

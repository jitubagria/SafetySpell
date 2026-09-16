import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ApiRouteConfigHop,
  ApiRouteConfigRoute,
  ApiRouteConfigStage,
  ApiTenantRole,
  ApiTenantRoleAuthorityClass,
  CoreApiError,
  createRouteConfigHop,
  createRouteConfigRoute,
  createRouteConfigStage,
  createRouteConfigTenantRole,
  getRouteConfigRoute,
  listRouteConfigHops,
  listRouteConfigRoutes,
  listRouteConfigStages,
  listRouteConfigTenantRoles,
  routeConfigQueryKeys,
  updateRouteConfigHop,
  updateRouteConfigRoute,
  updateRouteConfigStage,
  updateRouteConfigTenantRole,
} from "@/lib/core-api";

type ActionRequest = { action: string; request: () => Promise<unknown> };

function actionErrorMessage(error: unknown): string {
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
      return error.status >= 500
        ? `The Core API is unavailable (status ${error.status}). Check the connection and try again.`
        : error.message;
  }
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={
        active
          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
          : "rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
      }
    >
      {active ? "Active" : "Retired"}
    </span>
  );
}

function InlineError({ message }: { message?: string }) {
  return message ? <p className="text-sm font-semibold text-destructive">{message}</p> : null;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-5" aria-label={title}>
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}

function NamedCreateForm({
  label,
  placeholder,
  disabled,
  pending,
  error,
  onCreate,
}: {
  label: string;
  placeholder: string;
  disabled?: boolean;
  pending: boolean;
  error?: string;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onCreate(name)) setName("");
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-start gap-2">
      <label className="grid gap-1 text-sm font-medium">
        {label}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={placeholder}
          disabled={disabled || pending}
          required
        />
      </label>
      <Button className="mt-6" type="submit" disabled={disabled || pending}>
        {pending ? "Saving…" : error ? "Retry create" : "Create"}
      </Button>
      <div className="mt-7 basis-full">
        <InlineError message={error} />
      </div>
    </form>
  );
}

function RenameForm({
  action,
  currentName,
  pending,
  error,
  onRename,
}: {
  action: string;
  currentName: string;
  pending: boolean;
  error?: string;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(currentName);
  useEffect(() => setName(currentName), [currentName]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onRename(name);
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-start gap-2">
      <label className="sr-only" htmlFor={action}>
        Rename {currentName}
      </label>
      <input
        id={action}
        className="max-w-xs"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={pending}
        required
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : error ? "Retry rename" : "Rename"}
      </Button>
      <div className="basis-full">
        <InlineError message={error} />
      </div>
    </form>
  );
}

function RetireControl({
  label,
  explanation,
  pending,
  error,
  onRetire,
}: {
  label: string;
  explanation: string;
  pending: boolean;
  error?: string;
  onRetire: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);

  async function confirm() {
    if (await onRetire()) setConfirming(false);
  }

  if (!confirming) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Retire
      </Button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium">Retire {label}?</p>
      <p className="mt-1 text-sm text-muted-foreground">{explanation}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={() => void confirm()}
          disabled={pending}
        >
          {pending ? "Retiring…" : error ? "Retry retirement" : "Confirm retirement"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      <div className="mt-2">
        <InlineError message={error} />
      </div>
    </div>
  );
}

export function RouteConfigBuilder({
  token,
  onReauthenticate,
}: {
  token: string;
  onReauthenticate: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

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
  const routeDetail = useQuery({
    queryKey: selectedRouteId
      ? routeConfigQueryKeys.route(token, selectedRouteId)
      : ["route-config", "none"],
    queryFn: () => getRouteConfigRoute(token, selectedRouteId!),
    enabled: Boolean(selectedRouteId),
    retry: false,
  });
  const stages = useQuery({
    queryKey: selectedRouteId
      ? routeConfigQueryKeys.stages(token, selectedRouteId)
      : ["route-config", "stages", "none"],
    queryFn: () => listRouteConfigStages(token, selectedRouteId!),
    enabled: Boolean(selectedRouteId),
    retry: false,
  });
  const hops = useQuery({
    queryKey: selectedRouteId
      ? routeConfigQueryKeys.hops(token, selectedRouteId)
      : ["route-config", "hops", "none"],
    queryFn: () => listRouteConfigHops(token, selectedRouteId!),
    enabled: Boolean(selectedRouteId),
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: ({ request }: ActionRequest) => request(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["route-config"] });
    },
  });

  const selectedRoute = routes.data?.find((route) => route.id === selectedRouteId);
  const loadErrors = [routes.error, tenantRoles.error].filter((error): error is Error =>
    Boolean(error),
  );
  const uniqueLoadErrors = Array.from(
    new Map(loadErrors.map((error) => [actionErrorMessage(error), error])).values(),
  );
  const denied = loadErrors.some((error) => error instanceof CoreApiError && error.status === 403);
  const unauthenticated = loadErrors.some(
    (error) => error instanceof CoreApiError && error.status === 401,
  );
  const activeStages = stages.data?.filter((stage) => stage.active) ?? [];
  const activeRoles = tenantRoles.data?.filter((role) => role.active) ?? [];

  useEffect(() => {
    if (selectedRouteId && !selectedRoute) setSelectedRouteId(null);
  }, [selectedRoute, selectedRouteId]);

  async function runAction<T>(
    action: string,
    request: () => Promise<T>,
    onSaved?: (response: T) => void,
  ): Promise<boolean> {
    setActionErrors((current) => {
      const next = { ...current };
      delete next[action];
      return next;
    });
    try {
      const response = (await mutation.mutateAsync({ action, request })) as T;
      onSaved?.(response);
      return true;
    } catch (failure) {
      if (failure instanceof CoreApiError && failure.status === 401) onReauthenticate();
      setActionErrors((current) => ({ ...current, [action]: actionErrorMessage(failure) }));
      return false;
    }
  }

  function pending(action: string) {
    return mutation.isPending && mutation.variables?.action === action;
  }

  if (routes.isPending || tenantRoles.isPending) {
    return (
      <section className="mt-6 rounded-lg border p-5" aria-labelledby="route-config-title">
        <h2 id="route-config-title" className="text-xl font-bold">
          Route configuration
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">Loading live admin configuration…</p>
      </section>
    );
  }

  if (uniqueLoadErrors.length) {
    return (
      <section className="mt-6 rounded-lg border p-5" aria-labelledby="route-config-title">
        <h2 id="route-config-title" className="text-xl font-bold">
          Route configuration
        </h2>
        {uniqueLoadErrors.map((error) => (
          <div
            key={actionErrorMessage(error)}
            className="mt-4 rounded-md border border-destructive/40 p-3"
          >
            <p className="text-sm font-semibold text-destructive">{actionErrorMessage(error)}</p>
            <div className="mt-3 flex gap-2">
              {unauthenticated ? (
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
        {denied ? (
          <p className="mt-4 text-sm text-muted-foreground">
            The backend denied this request. No route or tenant-role data is shown.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="mt-6 grid gap-5" aria-labelledby="route-config-title">
      <header>
        <h2 id="route-config-title" className="text-xl font-bold">
          Route configuration
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Changes are sent to the live Core API and appear only after its canonical response is
          refetched. User-role assignment is intentionally deferred.
        </p>
        {notice ? (
          <p className="mt-3 rounded-md bg-emerald-50 p-3 text-sm font-medium">{notice}</p>
        ) : null}
      </header>

      <Panel title="Routes">
        <NamedCreateForm
          label="New route name"
          placeholder="e.g. Hospital issue route"
          pending={pending("create-route")}
          error={actionErrors["create-route"]}
          onCreate={(name) =>
            runAction(
              "create-route",
              () => createRouteConfigRoute(token, { name }),
              (route) => {
                setNotice(`Route “${route.name}” was created from the server response.`);
                setSelectedRouteId(route.id);
              },
            )
          }
        />
        <div className="mt-5 grid gap-3">
          {routes.data?.length ? (
            routes.data.map((route) => {
              const renameAction = `rename-route-${route.id}`;
              const retireAction = `retire-route-${route.id}`;
              return (
                <article key={route.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <button
                        type="button"
                        className="text-left font-semibold underline-offset-4 hover:underline"
                        onClick={() => setSelectedRouteId(route.id)}
                      >
                        {route.name}
                      </button>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {route.stage_count ?? 0} stages · {route.active_hop_count ?? 0} active hops
                      </p>
                    </div>
                    <StatusBadge active={route.active} />
                  </div>
                  <RenameForm
                    action={renameAction}
                    currentName={route.name}
                    pending={pending(renameAction)}
                    error={actionErrors[renameAction]}
                    onRename={(name) =>
                      runAction(
                        renameAction,
                        () => updateRouteConfigRoute(token, route.id, { name }),
                        (saved) =>
                          setNotice(`Route “${saved.name}” was renamed from the server response.`),
                      )
                    }
                  />
                  {route.active ? (
                    <RetireControl
                      label={route.name}
                      explanation="Retirement is soft-only and deactivates dependent stages and hops. Any stranded-tag count is shown only after the server confirms retirement."
                      pending={pending(retireAction)}
                      error={actionErrors[retireAction]}
                      onRetire={() =>
                        runAction(
                          retireAction,
                          () => updateRouteConfigRoute(token, route.id, { active: false }),
                          (saved) =>
                            setNotice(
                              `Route “${saved.name}” retired. The server reported ${saved.strandedTagCount ?? 0} stranded tag(s).`,
                            ),
                        )
                      }
                    />
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No routes configured yet.</p>
          )}
        </div>
      </Panel>

      <Panel title="Tenant roles">
        <TenantRoleCreateForm
          pending={pending("create-role")}
          error={actionErrors["create-role"]}
          onCreate={(name, authorityClass) =>
            runAction(
              "create-role",
              () => createRouteConfigTenantRole(token, { name, authorityClass }),
              (role) =>
                setNotice(`Tenant role “${role.name}” was created from the server response.`),
            )
          }
        />
        <div className="mt-5 grid gap-3">
          {tenantRoles.data?.length ? (
            tenantRoles.data.map((role) => {
              const renameAction = `rename-role-${role.id}`;
              const retireAction = `retire-role-${role.id}`;
              return (
                <article key={role.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">{role.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Authority class: {role.authority_class}
                      </p>
                    </div>
                    <StatusBadge active={role.active} />
                  </div>
                  <RenameForm
                    action={renameAction}
                    currentName={role.name}
                    pending={pending(renameAction)}
                    error={actionErrors[renameAction]}
                    onRename={(name) =>
                      runAction(
                        renameAction,
                        () => updateRouteConfigTenantRole(token, role.id, { name }),
                        (saved) =>
                          setNotice(
                            `Tenant role “${saved.name}” was renamed from the server response.`,
                          ),
                      )
                    }
                  />
                  {role.active ? (
                    <RetireControl
                      label={role.name}
                      explanation="Retirement is soft-only and deactivates dependent hops. It never deletes the role."
                      pending={pending(retireAction)}
                      error={actionErrors[retireAction]}
                      onRetire={() =>
                        runAction(
                          retireAction,
                          () => updateRouteConfigTenantRole(token, role.id, { active: false }),
                          (saved) =>
                            setNotice(
                              `Tenant role “${saved.name}” retired; dependent hops were deactivated by the server.`,
                            ),
                        )
                      }
                    />
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No tenant roles configured yet.</p>
          )}
        </div>
      </Panel>

      {selectedRoute ? (
        <RouteDetailBuilder
          route={selectedRoute}
          canonicalRouteName={routeDetail.data?.name}
          detailError={routeDetail.error ? actionErrorMessage(routeDetail.error) : undefined}
          stages={stages.data}
          stagesError={stages.error ? actionErrorMessage(stages.error) : undefined}
          hops={hops.data}
          hopsError={hops.error ? actionErrorMessage(hops.error) : undefined}
          activeStages={activeStages}
          activeRoles={activeRoles}
          pending={pending}
          errors={actionErrors}
          onRetryDetail={() => {
            void routeDetail.refetch();
            void stages.refetch();
            void hops.refetch();
          }}
          onCreateStage={(name) =>
            runAction(
              "create-stage",
              () => createRouteConfigStage(token, selectedRoute.id, { name }),
              (stage) => setNotice(`Stage “${stage.name}” was created from the server response.`),
            )
          }
          onRenameStage={(stage, name) =>
            runAction(
              `rename-stage-${stage.id}`,
              () => updateRouteConfigStage(token, stage.id, { name }),
              (saved) => setNotice(`Stage “${saved.name}” was renamed from the server response.`),
            )
          }
          onRetireStage={(stage) =>
            runAction(
              `retire-stage-${stage.id}`,
              () => updateRouteConfigStage(token, stage.id, { active: false }),
              (saved) =>
                setNotice(
                  `Stage “${saved.name}” retired. The server reported ${saved.strandedTagCount ?? 0} stranded tag(s).`,
                ),
            )
          }
          onCreateHop={(fromStageId, toStageId, allowedTenantRoleId) =>
            runAction(
              "create-hop",
              () =>
                createRouteConfigHop(token, selectedRoute.id, {
                  fromStageId,
                  toStageId,
                  allowedTenantRoleId,
                }),
              () => setNotice("Hop was created from the server response."),
            )
          }
          onRetireHop={(hop) =>
            runAction(
              `retire-hop-${hop.id}`,
              () => updateRouteConfigHop(token, hop.id, { active: false }),
              () => setNotice("Hop retired from the server response."),
            )
          }
        />
      ) : (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Select a route to view its live detail, stages, and hops.
        </p>
      )}
    </section>
  );
}

function TenantRoleCreateForm({
  pending,
  error,
  onCreate,
}: {
  pending: boolean;
  error?: string;
  onCreate: (name: string, authorityClass: ApiTenantRoleAuthorityClass) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [authorityClass, setAuthorityClass] =
    useState<ApiTenantRoleAuthorityClass>("operational_staff");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onCreate(name, authorityClass)) setName("");
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-start gap-2">
      <label className="grid gap-1 text-sm font-medium">
        New tenant-role name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Ward coordinator"
          disabled={pending}
          required
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Authority class
        <select
          value={authorityClass}
          onChange={(event) => setAuthorityClass(event.target.value as ApiTenantRoleAuthorityClass)}
          disabled={pending}
        >
          <option value="unprivileged">Unprivileged</option>
          <option value="operational_staff">Operational staff</option>
          <option value="guardian">Guardian</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <Button className="mt-6" type="submit" disabled={pending}>
        {pending ? "Saving…" : error ? "Retry create" : "Create"}
      </Button>
      <div className="basis-full">
        <InlineError message={error} />
      </div>
    </form>
  );
}

function RouteDetailBuilder({
  route,
  canonicalRouteName,
  detailError,
  stages,
  stagesError,
  hops,
  hopsError,
  activeStages,
  activeRoles,
  pending,
  errors,
  onRetryDetail,
  onCreateStage,
  onRenameStage,
  onRetireStage,
  onCreateHop,
  onRetireHop,
}: {
  route: ApiRouteConfigRoute;
  canonicalRouteName?: string;
  detailError?: string;
  stages?: ApiRouteConfigStage[];
  stagesError?: string;
  hops?: ApiRouteConfigHop[];
  hopsError?: string;
  activeStages: ApiRouteConfigStage[];
  activeRoles: ApiTenantRole[];
  pending: (action: string) => boolean;
  errors: Record<string, string>;
  onRetryDetail: () => void;
  onCreateStage: (name: string) => Promise<boolean>;
  onRenameStage: (stage: ApiRouteConfigStage, name: string) => Promise<boolean>;
  onRetireStage: (stage: ApiRouteConfigStage) => Promise<boolean>;
  onCreateHop: (
    fromStageId: string,
    toStageId: string,
    allowedTenantRoleId: string,
  ) => Promise<boolean>;
  onRetireHop: (hop: ApiRouteConfigHop) => Promise<boolean>;
}) {
  const parentInactive = !route.active;
  const detailFailure = detailError || stagesError || hopsError;

  return (
    <section
      className="grid gap-5 rounded-lg border-2 border-category p-5"
      aria-label="Selected route detail"
    >
      <header>
        <p className="text-sm font-bold uppercase tracking-wide text-category">Selected route</p>
        <h3 className="mt-1 text-xl font-bold">{canonicalRouteName ?? route.name}</h3>
        <div className="mt-2 flex items-center gap-2">
          <StatusBadge active={route.active} />
          <span className="text-sm text-muted-foreground">Live route detail, stages, and hops</span>
        </div>
      </header>
      {detailFailure ? (
        <div className="rounded-md border border-destructive/40 p-3">
          <InlineError message={detailFailure} />
          <Button
            className="mt-3"
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetryDetail}
          >
            Retry live request
          </Button>
        </div>
      ) : null}

      <Panel title="Stages">
        {parentInactive ? (
          <p className="mt-3 text-sm font-medium text-muted-foreground">
            This route is retired. The server will not accept new stages or hops for an inactive
            parent.
          </p>
        ) : null}
        <NamedCreateForm
          label="New stage name"
          placeholder="e.g. Received"
          disabled={parentInactive}
          pending={pending("create-stage")}
          error={errors["create-stage"]}
          onCreate={onCreateStage}
        />
        <div className="mt-5 grid gap-3">
          {stages?.length ? (
            stages.map((stage) => {
              const renameAction = `rename-stage-${stage.id}`;
              const retireAction = `retire-stage-${stage.id}`;
              return (
                <article key={stage.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-semibold">{stage.name}</p>
                    <StatusBadge active={stage.active} />
                  </div>
                  <RenameForm
                    action={renameAction}
                    currentName={stage.name}
                    pending={pending(renameAction)}
                    error={errors[renameAction]}
                    onRename={(name) => onRenameStage(stage, name)}
                  />
                  {stage.active ? (
                    <RetireControl
                      label={stage.name}
                      explanation="Retirement is soft-only, deactivates dependent hops, and may strand tags. The tag count is reported only after the server confirms retirement."
                      pending={pending(retireAction)}
                      error={errors[retireAction]}
                      onRetire={() => onRetireStage(stage)}
                    />
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No stages configured yet.</p>
          )}
        </div>
      </Panel>

      <Panel title="Hop permissions">
        <p className="mt-2 text-sm text-muted-foreground">
          A hop permits a tenant role to move a tag from one active stage to another. Stage order is
          not inferred here.
        </p>
        <HopCreateForm
          disabled={parentInactive || activeStages.length < 2 || activeRoles.length === 0}
          stages={activeStages}
          roles={activeRoles}
          pending={pending("create-hop")}
          error={errors["create-hop"]}
          onCreate={onCreateHop}
        />
        {!parentInactive && (activeStages.length < 2 || activeRoles.length === 0) ? (
          <p className="mt-3 text-sm text-muted-foreground">
            A hop needs two active stages and one active tenant role.
          </p>
        ) : null}
        <div className="mt-5 grid gap-3">
          {hops?.length ? (
            hops.map((hop) => {
              const retireAction = `retire-hop-${hop.id}`;
              return (
                <article key={hop.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">
                        {hop.from_stage_name ?? hop.from_stage_id} →{" "}
                        {hop.to_stage_name ?? hop.to_stage_id}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {hop.allowed_tenant_role_name ?? hop.allowed_tenant_role_id} ·{" "}
                        {hop.authority_class ?? "authority class unavailable"}
                      </p>
                    </div>
                    <StatusBadge active={hop.active} />
                  </div>
                  {hop.active ? (
                    <div className="mt-3">
                      <RetireControl
                        label="this hop"
                        explanation="Retirement is soft-only. The hop remains auditable but cannot authorize later stage moves."
                        pending={pending(retireAction)}
                        error={errors[retireAction]}
                        onRetire={() => onRetireHop(hop)}
                      />
                    </div>
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No hop permissions configured yet.</p>
          )}
        </div>
      </Panel>
    </section>
  );
}

function HopCreateForm({
  disabled,
  stages,
  roles,
  pending,
  error,
  onCreate,
}: {
  disabled: boolean;
  stages: ApiRouteConfigStage[];
  roles: ApiTenantRole[];
  pending: boolean;
  error?: string;
  onCreate: (
    fromStageId: string,
    toStageId: string,
    allowedTenantRoleId: string,
  ) => Promise<boolean>;
}) {
  const [fromStageId, setFromStageId] = useState("");
  const [toStageId, setToStageId] = useState("");
  const [allowedTenantRoleId, setAllowedTenantRoleId] = useState("");

  useEffect(() => {
    if (!stages.some((stage) => stage.id === fromStageId)) setFromStageId(stages[0]?.id ?? "");
    if (!stages.some((stage) => stage.id === toStageId))
      setToStageId(stages[1]?.id ?? stages[0]?.id ?? "");
  }, [fromStageId, stages, toStageId]);
  useEffect(() => {
    if (!roles.some((role) => role.id === allowedTenantRoleId))
      setAllowedTenantRoleId(roles[0]?.id ?? "");
  }, [allowedTenantRoleId, roles]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate(fromStageId, toStageId, allowedTenantRoleId);
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-sm font-medium">
        From stage
        <select
          value={fromStageId}
          onChange={(event) => setFromStageId(event.target.value)}
          disabled={disabled || pending}
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        To stage
        <select
          value={toStageId}
          onChange={(event) => setToStageId(event.target.value)}
          disabled={disabled || pending}
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Allowed tenant role
        <select
          value={allowedTenantRoleId}
          onChange={(event) => setAllowedTenantRoleId(event.target.value)}
          disabled={disabled || pending}
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name} ({role.authority_class})
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" disabled={disabled || pending}>
        {pending ? "Saving…" : error ? "Retry create" : "Create hop"}
      </Button>
      <div className="basis-full">
        <InlineError message={error} />
      </div>
    </form>
  );
}

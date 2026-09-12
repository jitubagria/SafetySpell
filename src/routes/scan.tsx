import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Phone, ShieldAlert } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { DemoGate } from "@/components/demo-gate";
import { coreApiUrl, scanTag } from "@/lib/core-api";

const categoryClass = (category?: string) =>
  category === "deaf_mute"
    ? "deaf-mute"
    : category === "epilepsy_cardiac"
      ? "epilepsy-cardiac"
      : category;

function displayValue(key: string, value: unknown): string {
  const labels: Record<string, Record<string, string>> = {
    age_band: { child: "Child", teen: "Teen", adult: "Adult", senior: "Senior" },
    primary_language: { hi: "Hindi", en: "English" },
  };
  return typeof value === "string" ? (labels[key]?.[value] ?? value) : String(value);
}

export const Route = createFileRoute("/scan")({
  validateSearch: z.object({ tag: z.string().optional() }),
  head: () => ({
    meta: [
      { title: "SafetySpell Rescue ID — demo scan" },
      { name: "description", content: "Demo-only public Rescue ID scan surface." },
    ],
  }),
  component: PublicScan,
});

function PublicScan() {
  const { tag } = Route.useSearch();
  const scan = useQuery({
    queryKey: ["public-scan", tag],
    queryFn: () => scanTag(tag ?? ""),
    enabled: typeof window !== "undefined" && Boolean(tag) && Boolean(coreApiUrl),
    retry: false,
  });
  const result = scan.data;
  const category = categoryClass(result?.category) ?? "medical";

  return (
    <div className="min-h-dvh bg-background text-foreground" data-category={category}>
      <DemoGate />
      <main className="mx-auto flex min-h-[calc(100dvh-40px)] w-full max-w-2xl flex-col px-5 py-6 sm:py-10">
        <header className="border-b border-border pb-5">
          <p className="text-sm font-bold uppercase tracking-wide text-category">
            SafetySpell · public scan web
          </p>
          <h1 className="mt-2 font-display text-4xl font-bold sm:text-5xl">Rescue ID demo</h1>
          <p className="mt-3 max-w-xl text-lg text-muted-foreground">
            Public information is fetched only from the configured local Core API after its
            server-side consent filter runs.
          </p>
        </header>
        <section className="border-y-2 border-category py-7" aria-labelledby="scan-result-title">
          <div className="flex items-start gap-4">
            <div className="grid size-20 shrink-0 place-items-center rounded-full bg-category-soft text-category">
              <ShieldAlert className="size-10" />
            </div>
            <div>
              <p className="text-sm font-bold uppercase text-category">Public scan result</p>
              <h2 id="scan-result-title" className="font-display text-3xl font-bold">
                {!tag
                  ? "Open a Rescue ID scan link"
                  : scan.isPending
                    ? "Checking this Rescue ID"
                    : result?.status === "available"
                      ? "Released information"
                      : "Rescue ID unavailable"}
              </h2>
              <ScanResult
                tag={tag}
                isConfigured={Boolean(coreApiUrl)}
                result={result}
                error={scan.error}
              />
            </div>
          </div>
        </section>
        <div className="mt-auto space-y-3 pt-6">
          <Button variant="emergency" className="w-full text-xl" type="button">
            <Phone className="size-7" />
            CALL FAMILY — DEMO ONLY
          </Button>
          <p className="text-center text-sm font-semibold text-muted-foreground">
            Demo only — does nothing yet.
          </p>
        </div>
      </main>
    </div>
  );
}

function ScanResult({
  tag,
  isConfigured,
  result,
  error,
}: {
  tag?: string;
  isConfigured: boolean;
  result: Awaited<ReturnType<typeof scanTag>> | undefined;
  error: Error | null;
}) {
  if (!isConfigured)
    return (
      <p className="mt-2 text-lg leading-relaxed text-muted-foreground">
        Local scan API is not configured.
      </p>
    );
  if (!tag)
    return (
      <p className="mt-2 text-lg leading-relaxed text-muted-foreground">
        Open a Rescue ID scan link to check its released information.
      </p>
    );
  if (error)
    return (
      <p className="mt-2 text-lg leading-relaxed text-muted-foreground">
        The scan service could not be reached.
      </p>
    );
  if (result?.status !== "available")
    return (
      <p className="mt-2 text-lg leading-relaxed text-muted-foreground">
        No public profile is available for this tag.
      </p>
    );
  if (!result.fields?.length)
    return (
      <p className="mt-2 text-lg leading-relaxed text-muted-foreground">
        No information has been released for this tag.
      </p>
    );
  return (
    <dl className="mt-4 grid gap-3">
      {result.fields.map((field) => (
        <div key={field.key} className="rounded-lg bg-category-soft px-4 py-3">
          <dt className="text-sm font-bold text-category">{field.label}</dt>
          <dd className="mt-1 text-lg font-semibold">{displayValue(field.key, field.value)}</dd>
          <p className="mt-1 text-xs text-muted-foreground">Family-provided information</p>
        </div>
      ))}
    </dl>
  );
}

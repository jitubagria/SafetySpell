import { createFileRoute } from "@tanstack/react-router";
import { Bell, CircleUserRound, Home, Plus, Settings, ShieldCheck, UsersRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryPicker, type RescueCategory } from "@/components/category-picker";
import { DemoGate } from "@/components/demo-gate";

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
  const [category, setCategory] = useState<RescueCategory>("elderly");
  return (
    <div className="min-h-dvh bg-app text-foreground" data-category={category}>
      <DemoGate />
      <main className="mx-auto min-h-[calc(100dvh-40px)] w-full max-w-3xl px-5 py-7 pb-28">
        <header>
          <p className="text-sm font-bold uppercase tracking-wide text-category">
            SafetySpell · guardian PWA
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold">Demo login shell</h1>
          <p className="mt-2 text-base text-muted-foreground">
            Authentication, guardian ownership, and profile saving are not implemented.
          </p>
        </header>
        <section className="mt-7" aria-label="Category token preview">
          <p className="mb-2 text-sm font-bold uppercase text-muted-foreground">
            Category token preview
          </p>
          <CategoryPicker value={category} onChange={setCategory} />
        </section>
        <section className="mt-7" aria-labelledby="wards-title">
          <div className="flex items-center justify-between gap-4">
            <h2 id="wards-title" className="text-xl font-bold">
              Demo wards
            </h2>
            <span className="text-sm font-semibold text-muted-foreground">2 sample cards</span>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <WardCard initials="ED" label="Elderly Rescue ID" />
            <WardCard initials="DM" label="Communication needs preview" />
          </div>
        </section>
        <Card className="mt-7 border-category/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="text-category" />
              Consent controls are preview-only
            </CardTitle>
            <CardDescription>
              There is no guardian account, per-ward consent record, public filter, or saved data in
              this version.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="touch" type="button">
              <Settings />
              EDIT DETAILS — DEMO ONLY
            </Button>
            <p className="mt-3 text-sm font-semibold text-muted-foreground">
              Demo only — does nothing yet.
            </p>
          </CardContent>
        </Card>
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-10 mx-auto grid h-20 max-w-3xl grid-cols-4 border-t border-border bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        aria-label="Guardian app preview navigation"
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
    </div>
  );
}

function WardCard({ initials, label }: { initials: string; label: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <div className="grid size-12 place-items-center rounded-full bg-category-soft font-bold text-category">
          {initials}
        </div>
        <div>
          <CardTitle className="text-lg">Demo ward</CardTitle>
          <CardDescription>{label}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="touch" type="button">
          <Plus />
          VIEW PROFILE — DEMO ONLY
        </Button>
        <p className="mt-3 text-sm font-semibold text-muted-foreground">
          Demo only — does nothing yet.
        </p>
      </CardContent>
    </Card>
  );
}

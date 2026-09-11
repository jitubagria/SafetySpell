import { createFileRoute } from "@tanstack/react-router";
import { Phone, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CategoryPicker, type RescueCategory } from "@/components/category-picker";
import { DemoGate } from "@/components/demo-gate";

export const Route = createFileRoute("/scan")({
  head: () => ({
    meta: [
      { title: "SafetySpell Rescue ID — demo scan" },
      { name: "description", content: "Demo-only public Rescue ID scan surface." },
    ],
  }),
  component: PublicScan,
});

function PublicScan() {
  const [category, setCategory] = useState<RescueCategory>("medical");
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
            A public, no-login layout preview. It contains no real person, profile, contact, or
            medical record.
          </p>
        </header>
        <section className="border-y-2 border-category py-7" aria-labelledby="demo-profile-title">
          <div className="flex items-start gap-4">
            <div className="grid size-20 shrink-0 place-items-center rounded-full bg-category-soft text-category">
              <ShieldAlert className="size-10" />
            </div>
            <div>
              <p className="text-sm font-bold uppercase text-category">Demo profile</p>
              <h2 id="demo-profile-title" className="font-display text-3xl font-bold">
                Emergency information preview
              </h2>
              <p className="mt-2 text-lg leading-relaxed text-muted-foreground">
                Real emergency guidance is unavailable in this prototype.
              </p>
            </div>
          </div>
        </section>
        <section className="py-6" aria-label="Category token preview">
          <p className="mb-2 text-sm font-bold uppercase text-muted-foreground">
            Category token preview
          </p>
          <CategoryPicker value={category} onChange={setCategory} />
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

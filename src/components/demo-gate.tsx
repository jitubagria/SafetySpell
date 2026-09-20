import { isProduction } from "@/lib/env";

export function DemoGate() {
  if (isProduction()) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="demo-gate"
      className="bg-warning px-4 py-2 text-center text-sm font-bold text-warning-foreground"
    >
      DEMO / PROTOTYPE — not for real emergencies
    </div>
  );
}

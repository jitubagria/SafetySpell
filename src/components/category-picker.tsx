import { EarOff, HeartPulse, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export type RescueCategory =
  "medical" | "elderly" | "kids" | "deaf-mute" | "disability" | "epilepsy-cardiac";
const options: Array<{ id: RescueCategory; label: string; icon: typeof HeartPulse }> = [
  { id: "medical", label: "Medical", icon: HeartPulse },
  { id: "elderly", label: "Elderly", icon: ShieldCheck },
  { id: "deaf-mute", label: "Deaf-mute", icon: EarOff },
];

export function CategoryPicker({
  value,
  onChange,
}: {
  value: RescueCategory;
  onChange: (value: RescueCategory) => void;
}) {
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      role="group"
      aria-label="Prototype category preview"
    >
      {options.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          variant={value === id ? "default" : "outline"}
          size="touch"
          onClick={() => onChange(id)}
          aria-pressed={value === id}
        >
          <Icon />
          {label}
        </Button>
      ))}
    </div>
  );
}

import { conditionFlagDefinitions, knownConditionFlagKeys } from "@/lib/condition-flags";

export function ConditionFlags({ keys }: { keys: unknown }) {
  const selected = new Set(knownConditionFlagKeys(keys));
  const flags = conditionFlagDefinitions.filter((definition) => selected.has(definition.key));
  if (!flags.length) return null;
  return (
    <ul className="mt-2 grid gap-2 text-left sm:grid-cols-2" aria-label="Condition flags">
      {flags.map((flag) => {
        const Icon = flag.icon;
        return (
          <li
            key={flag.key}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm font-semibold ${flag.critical ? "bg-destructive/10 text-destructive" : "bg-category-soft text-category"}`}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span>{flag.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

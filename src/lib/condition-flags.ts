import {
  Activity,
  BadgeAlert,
  CircleAlert,
  Droplet,
  Ear,
  Eye,
  Footprints,
  HeartCrack,
  HeartPulse,
  MessageSquareOff,
  Stethoscope,
  Wind,
  type LucideIcon,
} from "lucide-react";

export type ConditionFlagKey =
  | "epilepsy"
  | "cardiac"
  | "diabetes"
  | "blood_thinner"
  | "dialysis"
  | "pacemaker_implant"
  | "severe_allergy"
  | "asthma_copd"
  | "non_verbal"
  | "hearing_impaired"
  | "vision_impaired"
  | "wandering";

export type ConditionFlagDefinition = {
  key: ConditionFlagKey;
  label: string;
  critical: boolean;
  icon: LucideIcon;
};

export const conditionFlagDefinitions: readonly ConditionFlagDefinition[] = [
  { key: "epilepsy", label: "Epilepsy", critical: true, icon: Activity },
  { key: "cardiac", label: "Cardiac condition", critical: true, icon: HeartPulse },
  { key: "blood_thinner", label: "Blood thinner", critical: true, icon: Droplet },
  { key: "dialysis", label: "Dialysis", critical: true, icon: Stethoscope },
  { key: "pacemaker_implant", label: "Pacemaker implant", critical: true, icon: HeartCrack },
  { key: "severe_allergy", label: "Severe allergy", critical: true, icon: BadgeAlert },
  { key: "diabetes", label: "Diabetes", critical: false, icon: CircleAlert },
  { key: "asthma_copd", label: "Asthma / COPD", critical: false, icon: Wind },
  { key: "non_verbal", label: "Non-verbal", critical: false, icon: MessageSquareOff },
  { key: "hearing_impaired", label: "Hearing impaired", critical: false, icon: Ear },
  { key: "vision_impaired", label: "Vision impaired", critical: false, icon: Eye },
  { key: "wandering", label: "Wandering risk", critical: false, icon: Footprints },
];

const definitionByKey = new Map(
  conditionFlagDefinitions.map((definition) => [definition.key, definition]),
);

export function knownConditionFlagKeys(value: unknown): ConditionFlagKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (key): key is ConditionFlagKey =>
      typeof key === "string" && definitionByKey.has(key as ConditionFlagKey),
  );
}

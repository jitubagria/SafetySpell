import { BadRequestException } from "@nestjs/common";

export type FieldDataType = "text" | "short_text" | "boolean" | "enum";
export const CONDITION_FLAG_KEYS = [
  "epilepsy",
  "cardiac",
  "diabetes",
  "blood_thinner",
  "dialysis",
  "pacemaker_implant",
  "severe_allergy",
  "asthma_copd",
  "non_verbal",
  "hearing_impaired",
  "vision_impaired",
  "wandering",
] as const;
const CONDITION_FLAG_KEY_SET = new Set<string>(CONDITION_FLAG_KEYS);
export interface CatalogValidationPolicy {
  max_length?: number;
  allowed_values?: unknown[];
  multi_select?: boolean;
}

function isPolicy(value: unknown): value is CatalogValidationPolicy {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedValues(policy: unknown): unknown[] | undefined {
  if (
    !isPolicy(policy) ||
    !Array.isArray(policy.allowed_values) ||
    policy.allowed_values.length === 0
  ) {
    return undefined;
  }
  return policy.allowed_values;
}

function boundedTextMaxLength(policy: unknown): number | undefined {
  const max = isPolicy(policy) ? policy.max_length : undefined;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 1000) return undefined;
  return max;
}

function isMultiSelectEnum(policy: unknown): boolean {
  return isPolicy(policy) && policy.multi_select === true;
}

export function hasControlledPublicPolicy(dataType: string, policy: unknown): boolean {
  if (dataType === "enum" || dataType === "boolean") return Boolean(allowedValues(policy));
  // Public free text is admissible only when the catalog gives it a finite length bound.
  if (dataType === "text" || dataType === "short_text")
    return boundedTextMaxLength(policy) !== undefined;
  return false;
}

// Server-side safety lock for free-text values (the one control kept for public free text):
// strip HTML, neutralise clickable link schemes, force plain text, enforce the length cap.
// Line breaks are preserved so callers can keep one entry per line.
export function sanitizeFreeText(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  // Strip control characters (keep tab and newline) without a control-char regex.
  const noControl = Array.from(raw)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
  const noTags = noControl.replace(/<[^>]*>/g, " ");
  const noLinks = noTags
    .replace(/(?:https?|ftp|file|data|javascript|vbscript|mailto|tel):\/*/gi, "")
    .replace(/\bwww\.[^\s]*/gi, "[link removed]");
  const lines = noLinks
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0);
  return lines.join("\n").slice(0, maxLength);
}

// Returns the value to persist: unchanged for controlled types, sanitised for free text.
export function sanitizeCatalogValue(dataType: string, policy: unknown, value: unknown): unknown {
  if (dataType !== "text" && dataType !== "short_text") return value;
  return sanitizeFreeText(value, boundedTextMaxLength(policy) ?? 1000);
}

function hasExactConditionFlagPolicy(dataType: string, policy: unknown): boolean {
  const allowed = allowedValues(policy);
  return (
    dataType === "enum" &&
    isMultiSelectEnum(policy) &&
    Boolean(allowed) &&
    allowed!.length === CONDITION_FLAG_KEYS.length &&
    allowed!.every((key) => typeof key === "string" && CONDITION_FLAG_KEY_SET.has(key)) &&
    new Set(allowed!).size === CONDITION_FLAG_KEYS.length
  );
}

export function validateCatalogValue(
  dataType: string,
  policy: unknown,
  value: unknown,
  fieldKey?: string,
): void {
  if (dataType === "text" || dataType === "short_text") {
    const maxLength = isPolicy(policy) ? policy.max_length : undefined;
    if (
      typeof value !== "string" ||
      typeof maxLength !== "number" ||
      !Number.isInteger(maxLength) ||
      maxLength < 1 ||
      maxLength > 1000
    ) {
      throw new BadRequestException("Catalog text policy or value is invalid");
    }
    if (value.length > maxLength)
      throw new BadRequestException("Value exceeds the catalog length limit");
    return;
  }

  if (dataType === "boolean" && typeof value !== "boolean") {
    throw new BadRequestException("Value must be a boolean");
  }
  const allowed = allowedValues(policy);
  if (!allowed) {
    throw new BadRequestException("Value is not allowed by the catalog policy");
  }
  if (fieldKey === "condition_flags" && !hasExactConditionFlagPolicy(dataType, policy)) {
    throw new BadRequestException("Condition flags catalog policy is invalid");
  }
  if (dataType === "enum" && isMultiSelectEnum(policy)) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new BadRequestException("Multi-select enum values must be string arrays");
    }
    if (new Set(value).size !== value.length) {
      throw new BadRequestException("Multi-select enum values must not repeat keys");
    }
    if (
      !value.every(
        (entry) =>
          allowed.some((candidate) => Object.is(candidate, entry)) &&
          (fieldKey !== "condition_flags" || CONDITION_FLAG_KEY_SET.has(entry)),
      )
    ) {
      throw new BadRequestException("Value is not allowed by the catalog policy");
    }
    return;
  }
  if (dataType === "enum" && (typeof value === "object" || value === null)) {
    throw new BadRequestException("Enum values must be scalar controlled values");
  }
  if (!allowed.some((candidate) => Object.is(candidate, value))) {
    throw new BadRequestException("Value is not allowed by the catalog policy");
  }
}

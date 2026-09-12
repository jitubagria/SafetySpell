import { BadRequestException } from "@nestjs/common";

export type FieldDataType = "text" | "short_text" | "boolean" | "enum";
export interface CatalogValidationPolicy {
  max_length?: number;
  allowed_values?: unknown[];
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

export function hasControlledPublicPolicy(dataType: string, policy: unknown): boolean {
  return (dataType === "enum" || dataType === "boolean") && Boolean(allowedValues(policy));
}

export function validateCatalogValue(dataType: string, policy: unknown, value: unknown): void {
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
  if (dataType === "enum" && (typeof value === "object" || value === null)) {
    throw new BadRequestException("Enum values must be scalar controlled values");
  }
  const allowed = allowedValues(policy);
  if (!allowed || !allowed.some((candidate) => Object.is(candidate, value))) {
    throw new BadRequestException("Value is not allowed by the catalog policy");
  }
}

import { randomBytes } from "node:crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const shortCodePattern = /^SS-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})$/;

/**
 * A readable five-bit check value for the seven-character payload. It catches
 * common transcription errors before a public scan reaches Postgres; it is not
 * intended to add secrecy to the code.
 */
function checksum(payload: string): string {
  let value = 0;
  for (const character of payload) {
    value = ((value * 3) ^ alphabet.indexOf(character)) & 31;
  }
  return alphabet[value]!;
}

export function createPublicTagCode(): string {
  // 256 is divisible by 32, so masking each random byte yields an unbiased
  // Crockford Base32 character.
  const payload = [...randomBytes(7)].map((byte) => alphabet[byte & 31]).join("");
  return `SS-${payload.slice(0, 4)}-${payload.slice(4)}${checksum(payload)}`;
}

export function normalizeTagCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Legacy long codes remain resolvable while printed stock is exhausted. */
export function isValidPublicTagCode(value: string): boolean {
  const match = shortCodePattern.exec(normalizeTagCode(value));
  if (!match) return true;
  const payload = `${match[1]!}${match[2]!.slice(0, 3)}`;
  return checksum(payload) === match[2]!.slice(3);
}

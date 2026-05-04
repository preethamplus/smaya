// PII masking + post-mask assertions.
//
// Why this lives in shared (not just resume-parser): the post-parse assertion
// in §5.3 must run *anywhere* a profile crosses a persistence boundary. The
// data layer imports `assertNoPII` to guard Cosmos writes.

import { createHash } from "node:crypto";

export function tokenize(kind: "NAME" | "EMAIL" | "PHONE", value: string): string {
  const h = createHash("sha256")
    .update(`${kind}:${value.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `[${kind}:${h}]`;
}

export function generalizeLocation(loc: string): string {
  // "Bengaluru, India" → "India". Drop city granularity to reduce identifiability.
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? loc;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/;

/** Throws if obviously-PII fields leak through. Used at the data-write boundary. */
export function assertNoPII(obj: unknown): void {
  const json = JSON.stringify(obj ?? {});
  // Allow tokenized references like "[EMAIL:ABC12345]" — those don't trip the regex.
  if (EMAIL_RE.test(json)) {
    throw new PIILeakError("PII assertion failed: raw email present in object");
  }
  if (PHONE_RE.test(json) && !/\[PHONE:[A-F0-9]{8}\]/.test(json)) {
    // phone regex is broad — only flag if it's NOT already wrapped in a token
    const stripped = json.replace(/\[PHONE:[A-F0-9]{8}\]/g, "");
    if (PHONE_RE.test(stripped)) {
      throw new PIILeakError("PII assertion failed: raw phone present in object");
    }
  }
}

export class PIILeakError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PIILeakError";
  }
}

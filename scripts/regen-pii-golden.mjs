// Regenerates fixtures/golden/pii-golden.json with correct hash tokens
// derived from the live tokenize() / generalizeLocation() implementations.
// Run after any change to packages/shared/src/pii.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

function tokenize(kind, value) {
  const h = createHash("sha256")
    .update(`${kind}:${value.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `[${kind}:${h}]`;
}
function generalizeLocation(loc) {
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? loc;
}

const path = resolve("fixtures/golden/pii-golden.json");
const golden = JSON.parse(readFileSync(path, "utf8"));

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;

for (const g of golden) {
  const lines = g.rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const name = lines[0];
  const headerMeta = lines[1] ?? "";
  const email = (g.rawText.match(EMAIL_RE) ?? [""])[0];
  const phone = (g.rawText.match(PHONE_RE) ?? [""])[0];
  const locationBit = headerMeta.split(/[·•]/).map((s) => s.trim()).find((s) => !EMAIL_RE.test(s) && !PHONE_RE.test(s));
  const location = locationBit || "Unknown";

  g.expectedMaskedFields = {
    nameToken: tokenize("NAME", name),
    emailToken: tokenize("EMAIL", email),
    phoneToken: tokenize("PHONE", phone),
    locationGeneralized: generalizeLocation(location),
  };
}

writeFileSync(path, JSON.stringify(golden, null, 2) + "\n");
console.log(`regenerated ${path} with ${golden.length} entries`);

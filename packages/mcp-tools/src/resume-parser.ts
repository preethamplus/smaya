// MCP tool: resume-parser
// Real local PDF parser + PII masker. No external API.
// Parses a PDF buffer, extracts a structured resume, returns a MaskedProfile.

import { z } from "zod";
import { readFileSync } from "node:fs";
import { defineTool } from "./wrap.js";
import {
  ParsedResumeRaw,
  MaskedProfile,
  type MaskedProfile as MaskedProfileT,
} from "@smaya/shared/schemas";
import { tokenize, generalizeLocation, assertNoPII } from "@smaya/shared/pii";

const Input = z.object({
  /** Either an absolute file path OR a base64-encoded PDF buffer. */
  pdfPath: z.string().optional(),
  pdfBase64: z.string().optional(),
  /** Caller hints these so the parser doesn't have to guess. The id is the only mandatory hint. */
  candidateId: z.string().regex(/^c\d{2,}$/),
}).refine((x) => x.pdfPath || x.pdfBase64, { message: "pdfPath or pdfBase64 required" });

const Output = z.object({
  masked: MaskedProfile,
  /** A second copy of the parsed-but-unmasked structure passed back ONLY for the eval harness;
   *  the orchestrator never persists this. */
  raw: ParsedResumeRaw,
});

export type ResumeParserInput = z.infer<typeof Input>;
export type ResumeParserOutput = z.infer<typeof Output>;

export const resumeParser = defineTool({
  name: "resume-parser",
  scope: "resume:read",
  inputSchema: Input,
  outputSchema: Output,
  handler: async (input) => {
    const buf = input.pdfPath ? readFileSync(input.pdfPath) : Buffer.from(input.pdfBase64!, "base64");

    // Use pdfjs-dist (Mozilla's library) — more reliable on Node 20+ than pdf-parse.
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as {
      getDocument: (src: { data: Uint8Array }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str: string; transform?: number[]; height?: number }> }> }> }> };
    };
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const lines: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // Reconstruct lines from items by Y coordinate (transform[5]).
      const itemsByY = new Map<number, string[]>();
      for (const it of content.items) {
        const y = it.transform?.[5] ?? 0;
        const key = Math.round(y);
        const arr = itemsByY.get(key) ?? [];
        arr.push(it.str);
        itemsByY.set(key, arr);
      }
      const ys = [...itemsByY.keys()].sort((a, b) => b - a);
      for (const y of ys) {
        const line = (itemsByY.get(y) ?? []).join("").trim();
        if (line) lines.push(line);
      }
    }
    const text = lines.join("\n");

    const raw = extractFromText(text, input.candidateId);
    const masked = maskProfile(raw);

    // Defense in depth: assert before returning, so the orchestrator can't accidentally
    // persist a leak even if a downstream changed something.
    assertNoPII(masked);

    return { masked, raw };
  },
});

// ---- extraction ----------------------------------------------------------

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;
const URL_LINKEDIN = /linkedin\.com\/[\w-]+/i;
const URL_GITHUB = /github\.com\/[\w-]+/i;

export function extractFromText(text: string, id: string): ParsedResumeRaw {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const name = lines[0] ?? "Unknown";
  const email = (text.match(EMAIL_RE) ?? [""])[0];
  const phone = (text.match(PHONE_RE) ?? [""])[0];
  const linkedin = (text.match(URL_LINKEDIN) ?? [""])[0] || undefined;
  const github = (text.match(URL_GITHUB) ?? [""])[0] || undefined;

  // Header line 2: "email · phone · location" — split on the bullet/dot.
  const headerMeta = lines[1] ?? "";
  const locationMatch = headerMeta.split(/[·•]/).map((s) => s.trim()).find((s) => !EMAIL_RE.test(s) && !PHONE_RE.test(s));
  const location = locationMatch || "Unknown";

  const summary = sectionText(lines, "Summary");
  const skills = sectionText(lines, "Skills")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const experience = parseExperience(lines);
  const education = parseEducation(lines);

  return ParsedResumeRaw.parse({
    id,
    name,
    email,
    phone,
    location,
    linkedin,
    github,
    summary: summary || "—",
    skills,
    experience,
    education,
  });
}

function sectionText(lines: string[], header: string): string {
  const start = lines.findIndex((l) => l.toLowerCase() === header.toLowerCase());
  if (start < 0) return "";
  const buf: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (isHeader(l)) break;
    buf.push(l);
  }
  return buf.join(" ").trim();
}

function isHeader(line: string): boolean {
  return ["Summary", "Skills", "Experience", "Education"].some((h) => h.toLowerCase() === line.toLowerCase());
}

function parseExperience(lines: string[]): ParsedResumeRaw["experience"] {
  const start = lines.findIndex((l) => l.toLowerCase() === "experience");
  if (start < 0) return [];
  const out: ParsedResumeRaw["experience"] = [];
  let cur: ParsedResumeRaw["experience"][number] | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (isHeader(l)) break;
    const title = l.match(/^(.+?)\s+—\s+(.+)$/);
    if (title) {
      if (cur) out.push(cur);
      cur = { role: title[1] ?? "", company: title[2] ?? "", years: "", highlights: [] };
      continue;
    }
    if (!cur) continue;
    if (/^\d{4}/.test(l) || /\d{4}.*present/i.test(l)) {
      cur.years = l;
    } else if (l.startsWith("•")) {
      cur.highlights.push(l.replace(/^•\s*/, ""));
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseEducation(lines: string[]): ParsedResumeRaw["education"] {
  const start = lines.findIndex((l) => l.toLowerCase() === "education");
  if (start < 0) return [];
  const out: ParsedResumeRaw["education"] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (isHeader(l)) break;
    const m = l.match(/^(.+?),\s+(.+?)\s+\((\d{4})\)$/);
    if (m) {
      out.push({ degree: m[1] ?? "", school: m[2] ?? "", year: parseInt(m[3] ?? "0", 10) });
    }
  }
  return out;
}

// ---- masking -------------------------------------------------------------

export function maskProfile(raw: ParsedResumeRaw): MaskedProfileT {
  const yearsTotal = raw.experience.reduce((acc, e) => {
    const m = e.years.match(/(\d{4}).*?(\d{4}|present)/i);
    if (!m) return acc;
    const start = parseInt(m[1] ?? "0", 10);
    const end = (m[2] ?? "").toLowerCase() === "present" ? new Date().getFullYear() : parseInt(m[2] ?? "0", 10);
    return acc + Math.max(0, end - start);
  }, 0);

  return MaskedProfile.parse({
    id: raw.id,
    nameToken: tokenize("NAME", raw.name),
    emailToken: tokenize("EMAIL", raw.email),
    phoneToken: tokenize("PHONE", raw.phone),
    locationGeneralized: generalizeLocation(raw.location),
    hasLinkedIn: !!raw.linkedin,
    hasGitHub: !!raw.github,
    yearsTotal,
    summary: raw.summary,
    skills: raw.skills,
    experience: raw.experience,
    education: raw.education,
  });
}

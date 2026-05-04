// Minimal OAuth 2.1 *stub* for MCP tools. Spec only requires the discipline,
// not real provider integration. We mint a short-lived bearer token tied to
// (tenantId, tool, scopes) and validate it on every call. Tokens persist
// in-memory only — restart-safe is not required for stubs.

import { createHash, randomBytes } from "node:crypto";

const TOKEN_TTL_MS = 5 * 60 * 1000;

interface Token {
  value: string;
  tenantId: string;
  tool: string;
  scopes: string[];
  expiresAt: number;
}

const tokens = new Map<string, Token>();

export interface IssueTokenInput {
  tenantId: string;
  tool: string;
  scopes: string[];
}

export function issueToken({ tenantId, tool, scopes }: IssueTokenInput): string {
  const value = `mcp_${randomBytes(16).toString("hex")}`;
  tokens.set(value, {
    value,
    tenantId,
    tool,
    scopes,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return value;
}

export function validateToken(token: string, tool: string, requiredScope: string, tenantId: string): void {
  const t = tokens.get(token);
  if (!t) throw new OAuthError("invalid_token");
  if (t.expiresAt < Date.now()) throw new OAuthError("token_expired");
  if (t.tenantId !== tenantId) throw new OAuthError("tenant_mismatch");
  if (t.tool !== tool) throw new OAuthError("tool_mismatch");
  if (!t.scopes.includes(requiredScope)) throw new OAuthError("missing_scope");
}

export class OAuthError extends Error {
  constructor(public code: string) {
    super(`oauth: ${code}`);
    this.name = "OAuthError";
  }
}

/** Stable hash for idempotency keys. */
export function stableHash(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

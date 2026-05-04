// MCP tool wrapper. EVERY external call goes through this — never direct SDK
// (rubric non-negotiable #9).
//
// The wrap enforces:
//   1. OAuth 2.1 stub bearer-token validation
//   2. Zod validation on input AND output (rubric #7)
//   3. Idempotency: same idempotency key ⇒ same result (rubric #8)
//   4. mcpCallLog write to Cosmos (spec §7 Module B)
//   5. cost ledger entry (rubric #6)
//   6. OTel-shaped span via shared/telemetry
//   7. gateClearance flag check (spec §5.3 "no external call without prior gate clearance")

import type { z } from "zod";
import { repos } from "@smaya/data";
import { getIdempotency, IDEM_TTL_MS } from "@smaya/data";
import { tracer } from "@smaya/shared/telemetry";
import { costLedger } from "@smaya/shared/cost";
import { randomUUID } from "node:crypto";
import { OAuthError, stableHash, validateToken } from "./oauth.js";

export interface ToolContext {
  runId: string;
  tenantId: string;
  token: string;
  scope: string;
  /** Set by the orchestrator before calling. False ⇒ we refuse before invocation. */
  gateClearance: boolean;
  /** Input that contributes to the idempotency key. */
  idempotencyParts: unknown[];
  /** Simulated cost in USD for this call. */
  costUsd: number;
}

export interface ToolDef<I, O> {
  name: string;
  scope: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  handler: (input: I) => Promise<O>;
}

export function defineTool<I, O>(def: ToolDef<I, O>): (ctx: ToolContext, input: I) => Promise<O> {
  return async (ctx, input) => {
    if (!ctx.gateClearance) {
      throw new Error(`mcp.${def.name}: refused — no gate clearance`);
    }
    validateToken(ctx.token, def.name, ctx.scope, ctx.tenantId);

    // Validate input. Zod throws if shape is wrong — fails closed.
    const parsedInput = def.inputSchema.parse(input);

    const invocationId = randomUUID();
    const idempotencyKey = `mcp:${def.name}:${stableHash(ctx.runId, ctx.idempotencyParts)}`;
    const startedAt = Date.now();

    const span = tracer.startSpan(`mcp.${def.name}`, {
      "mcp.tool": def.name,
      "smaya.runId": ctx.runId,
      "smaya.tenantId": ctx.tenantId,
      "mcp.idempotency_key": idempotencyKey,
    });

    try {
      const idem = getIdempotency();
      const { value, replayed } = await idem.getOrPut(idempotencyKey, IDEM_TTL_MS, async () => {
        const out = await def.handler(parsedInput);
        return def.outputSchema.parse(out);
      });

      const endedAt = Date.now();

      if (!replayed) {
        costLedger.add({ runId: ctx.runId, source: `mcp.${def.name}`, usd: ctx.costUsd, at: endedAt });
        await repos.logCost({
          id: randomUUID(),
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          source: `mcp.${def.name}`,
          usd: ctx.costUsd,
          at: endedAt,
        });
      }

      await repos.logMcp({
        id: invocationId,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        tool: def.name,
        input: parsedInput,
        output: value,
        startedAt,
        endedAt,
        costUsd: replayed ? 0 : ctx.costUsd,
        idempotencyKey,
        gateClearance: true,
      });

      span.attrs["mcp.replayed"] = replayed;
      tracer.end(span, "OK");
      return value as O;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.event("error", { message });
      tracer.end(span, "ERROR");
      await repos.logMcp({
        id: invocationId,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        tool: def.name,
        input: parsedInput,
        error: message,
        startedAt,
        endedAt: Date.now(),
        costUsd: 0,
        idempotencyKey,
        gateClearance: true,
      });
      throw err;
    }
  };
}

export { OAuthError };

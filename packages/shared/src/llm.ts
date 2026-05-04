// LLM-agnostic interface. The orchestrator calls *only* through this.
// Three implementations: deterministic mock (default), Anthropic, Ollama.
// Choice via SMAYA_LLM = "mock" | "anthropic" | "ollama".

import { createHash } from "node:crypto";

export interface LLMRequest {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Optional seed for stability — feeds into the deterministic stub's hash key. */
  stableKey?: string;
}

export interface LLMResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  provider: "mock" | "anthropic" | "ollama";
}

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ---- Deterministic mock ---------------------------------------------------

class DeterministicMockLLM implements LLMClient {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const key = createHash("sha256")
      .update(`${req.system}\n---\n${req.prompt}\n---\n${req.stableKey ?? ""}`)
      .digest("hex");

    // Score-shaped responses: numeric output keyed by hash.
    if (req.system.includes("SCORE_TASK")) {
      const composite = 40 + (parseInt(key.slice(0, 4), 16) % 60);
      const dims = {
        skills_match: 30 + (parseInt(key.slice(4, 8), 16) % 70),
        experience: 30 + (parseInt(key.slice(8, 12), 16) % 70),
        domain_fit: 30 + (parseInt(key.slice(12, 16), 16) % 70),
        signal_quality: 30 + (parseInt(key.slice(16, 20), 16) % 70),
      };
      const text = JSON.stringify({
        composite,
        dimensions: dims,
        rationale: `Deterministic score ${composite}/100. Dimensions reflect skills and experience derived from masked profile + interview signal.`,
      });
      return {
        text,
        usage: { inputTokens: req.prompt.length / 4, outputTokens: text.length / 4 },
        costUsd: 0.001,
        provider: "mock",
      };
    }

    // Intent-classifier-shaped responses for chat: returns intent + confidence.
    if (req.system.includes("INTENT_CLASSIFIER")) {
      // Mock just returns STATUS_QUERY for anything not regex-handled.
      const text = JSON.stringify({ intent: "STATUS_QUERY", confidence: 0.5 });
      return {
        text,
        usage: { inputTokens: 50, outputTokens: 20 },
        costUsd: 0.0005,
        provider: "mock",
      };
    }

    // Generic fallback.
    const text = `MOCK_RESPONSE:${key.slice(0, 16)}`;
    return {
      text,
      usage: { inputTokens: req.prompt.length / 4, outputTokens: text.length / 4 },
      costUsd: 0.0002,
      provider: "mock",
    };
  }
}

// ---- Anthropic stub (real impl wired only when SMAYA_LLM=anthropic and API key set) ----

class AnthropicLLM implements LLMClient {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Lazy import to avoid forcing reviewers to install @anthropic-ai/sdk.
    const { default: Anthropic } = await import("@anthropic-ai/sdk").catch(() => ({ default: null as never }));
    if (!Anthropic) throw new Error("@anthropic-ai/sdk not installed; SMAYA_LLM=anthropic requires it");
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set");
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      system: req.system,
      max_tokens: req.maxTokens ?? 512,
      temperature: req.temperature ?? 0,
      messages: [{ role: "user", content: req.prompt }],
    });
    const text = res.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");
    const usage = res.usage as { input_tokens: number; output_tokens: number };
    // Approximate cost using Haiku 4.5 pricing.
    const costUsd =
      (usage.input_tokens / 1e6) * 1.0 +
      (usage.output_tokens / 1e6) * 5.0;
    return {
      text,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      costUsd,
      provider: "anthropic",
    };
  }
}

// ---- Ollama stub ----------------------------------------------------------

class OllamaLLM implements LLMClient {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const url = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
    const model = process.env.OLLAMA_MODEL ?? "llama3.1";
    const body = JSON.stringify({
      model,
      prompt: `${req.system}\n\n${req.prompt}`,
      stream: false,
      options: { temperature: req.temperature ?? 0 },
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`ollama returned ${res.status}`);
    const data = (await res.json()) as { response: string; eval_count?: number; prompt_eval_count?: number };
    return {
      text: data.response ?? "",
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      costUsd: 0,
      provider: "ollama",
    };
  }
}

// ---- Factory --------------------------------------------------------------

export function makeLLM(): LLMClient {
  const provider = (process.env.SMAYA_LLM ?? "mock").toLowerCase();
  if (provider === "anthropic") return new AnthropicLLM();
  if (provider === "ollama") return new OllamaLLM();
  return new DeterministicMockLLM();
}

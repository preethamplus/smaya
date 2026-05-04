// MCP tool: slack-poster
// Talks to a LOCAL HTTP server that records POSTs and exposes them to the UI.
// (See mock-servers.ts for the recording server.)

import { z } from "zod";
import { defineTool } from "./wrap.js";

const Input = z.object({
  channel: z.string(),
  text: z.string(),
  blocks: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const Output = z.object({
  ok: z.boolean(),
  ts: z.string(),
  channel: z.string(),
  permalink: z.string(),
});

export type SlackPosterInput = z.infer<typeof Input>;
export type SlackPosterOutput = z.infer<typeof Output>;

export const slackPoster = defineTool({
  name: "slack-poster",
  scope: "slack:post",
  inputSchema: Input,
  outputSchema: Output,
  handler: async (input) => {
    const url = process.env.MOCK_SLACK_URL ?? "http://localhost:5101/post";
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`mock-slack returned ${res.status}`);
    return (await res.json()) as SlackPosterOutput;
  },
});

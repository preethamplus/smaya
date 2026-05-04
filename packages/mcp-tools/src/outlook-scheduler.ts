// MCP tool: outlook-scheduler
// Talks to a LOCAL HTTP server that records calendar events + emails.
// Two operations: send-email and create-event.

import { z } from "zod";
import { defineTool } from "./wrap.js";

const SendEmailIn = z.object({
  op: z.literal("send-email"),
  to: z.array(z.string().email()),
  subject: z.string(),
  body: z.string(),
});

const CreateEventIn = z.object({
  op: z.literal("create-event"),
  attendees: z.array(z.string().email()),
  subject: z.string(),
  startsAt: z.number(),
  endsAt: z.number(),
  description: z.string(),
});

const Input = z.discriminatedUnion("op", [SendEmailIn, CreateEventIn]);

const Output = z.object({
  ok: z.boolean(),
  id: z.string(),
  kind: z.enum(["email", "event"]),
  webLink: z.string(),
});

export type OutlookSchedulerInput = z.infer<typeof Input>;
export type OutlookSchedulerOutput = z.infer<typeof Output>;

export const outlookScheduler = defineTool({
  name: "outlook-scheduler",
  scope: "outlook:write",
  inputSchema: Input,
  outputSchema: Output,
  handler: async (input) => {
    const url = process.env.MOCK_OUTLOOK_URL ?? "http://localhost:5102/op";
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`mock-outlook returned ${res.status}`);
    return (await res.json()) as OutlookSchedulerOutput;
  },
});

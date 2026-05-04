// Local HTTP servers that mock Slack and Outlook. They record every payload to
// in-memory arrays exposed via GET /messages and GET /events. The UI reads these.
//
// They also write artifacts to artifacts/mock-slack/*.json and artifacts/mock-outlook/*.json
// so a reviewer can inspect them without running the UI.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const ARTIFACT_DIR = resolve(process.cwd(), "artifacts");

interface SlackMessage {
  ts: string;
  channel: string;
  text: string;
  blocks?: unknown[];
  metadata?: Record<string, unknown>;
}
interface OutlookEmail {
  id: string;
  kind: "email";
  to: string[];
  subject: string;
  body: string;
  webLink: string;
  at: number;
}
interface OutlookEvent {
  id: string;
  kind: "event";
  attendees: string[];
  subject: string;
  startsAt: number;
  endsAt: number;
  description: string;
  webLink: string;
  at: number;
}

const slackMessages: SlackMessage[] = [];
const outlookEmails: OutlookEmail[] = [];
const outlookEvents: OutlookEvent[] = [];

function persistArtifact(subdir: string, id: string, body: unknown): void {
  try {
    const path = `${ARTIFACT_DIR}/${subdir}/${id}.json`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2));
  } catch {
    // best effort — UI still has the in-memory copy
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export function startMockSlack(port = 5101): Server {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "POST" && req.url === "/post") {
      const body = (await readJson(req)) as { channel: string; text: string; blocks?: unknown[]; metadata?: Record<string, unknown> };
      const ts = `${Date.now() / 1000}`;
      const msg: SlackMessage = { ts, channel: body.channel, text: body.text, blocks: body.blocks, metadata: body.metadata };
      slackMessages.push(msg);
      persistArtifact("mock-slack", ts, msg);
      return send(res, 200, { ok: true, ts, channel: body.channel, permalink: `slack://${body.channel}/${ts}` });
    }
    if (req.method === "GET" && req.url === "/messages") return send(res, 200, slackMessages);
    return send(res, 404, { error: "not found" });
  });
  server.listen(port);
  return server;
}

export function startMockOutlook(port = 5102): Server {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "POST" && req.url === "/op") {
      const body = (await readJson(req)) as
        | { op: "send-email"; to: string[]; subject: string; body: string }
        | { op: "create-event"; attendees: string[]; subject: string; startsAt: number; endsAt: number; description: string };
      const id = randomUUID();
      const at = Date.now();
      if (body.op === "send-email") {
        const e: OutlookEmail = {
          id,
          kind: "email",
          to: body.to,
          subject: body.subject,
          body: body.body,
          webLink: `outlook://email/${id}`,
          at,
        };
        outlookEmails.push(e);
        persistArtifact("mock-outlook", `email-${id}`, e);
        return send(res, 200, { ok: true, id, kind: "email", webLink: e.webLink });
      }
      const ev: OutlookEvent = {
        id,
        kind: "event",
        attendees: body.attendees,
        subject: body.subject,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        description: body.description,
        webLink: `outlook://event/${id}`,
        at,
      };
      outlookEvents.push(ev);
      persistArtifact("mock-outlook", `event-${id}`, ev);
      return send(res, 200, { ok: true, id, kind: "event", webLink: ev.webLink });
    }
    if (req.method === "GET" && req.url === "/emails") return send(res, 200, outlookEmails);
    if (req.method === "GET" && req.url === "/events") return send(res, 200, outlookEvents);
    return send(res, 404, { error: "not found" });
  });
  server.listen(port);
  return server;
}

export function getSlackMessages(): SlackMessage[] {
  return [...slackMessages];
}
export function getOutlookEmails(): OutlookEmail[] {
  return [...outlookEmails];
}
export function getOutlookEvents(): OutlookEvent[] {
  return [...outlookEvents];
}
export function resetMocks(): void {
  slackMessages.length = 0;
  outlookEmails.length = 0;
  outlookEvents.length = 0;
}

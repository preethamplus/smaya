// Spawns the intervention-api server, the UI dev server, and (optionally) a
// pre-built mission. Used by `npm run dev`. Replaces a docker-compose layer
// because the API server itself starts the mock Slack + Outlook listeners.
import { spawn } from "node:child_process";

const procs = [];

function start(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  p.stdout.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  p.stderr.on("data", (b) => process.stderr.write(`[${name}] ${b}`));
  p.on("exit", (code) => console.log(`[${name}] exited ${code}`));
  procs.push(p);
  return p;
}

// API also boots mock Slack + Outlook via mock-servers when a Mission is registered.
// We boot them eagerly here so the UI can fetch even before a mission starts.
start("mocks", "npx", ["--yes", "tsx", "packages/mcp-tools/src/mock-servers-cli.ts"]);
start("api", "npx", ["--yes", "tsx", "packages/intervention-api/src/server.ts"]);
start("ui", "npm", ["run", "dev", "-w", "@smaya/ui"]);

const shutdown = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

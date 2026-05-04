// HTTP server hosting the GraphQL endpoint at /graphql + an SSE bridge at /events
// for the UI. Yoga handles WS subscriptions out of the box, but we keep an
// SSE endpoint as a fallback for environments where WS isn't available.

import { createServer } from "node:http";
import { createYoga, createSchema } from "graphql-yoga";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { bus } from "@smaya/orchestrator";

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: "/graphql",
  cors: { origin: ["http://localhost:3000"], credentials: true },
});

const server = createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
      connection: "keep-alive",
    });
    const off = bus.onRun((e) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    req.on("close", () => {
      off();
    });
    return;
  }
  return yoga(req, res);
});

const port = Number(process.env.SMAYA_API_PORT ?? 4000);
server.listen(port, () => {
  console.log(`intervention-api  http://localhost:${port}/graphql`);
});

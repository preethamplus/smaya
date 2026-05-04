// Thin GraphQL client — no library, just fetch. Subscriptions via SSE.

const ENDPOINT = "http://localhost:4000/graphql";
const SSE_URL = "http://localhost:4000/events";

interface GqlError { message: string; }

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: GqlError[] };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data!;
}

export interface RunEvent {
  type: string;
  runId: string;
  detail: unknown;
  at: number;
}

export function subscribeRunEvents(onEvent: (e: RunEvent) => void): () => void {
  const es = new EventSource(SSE_URL);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as RunEvent);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}

// Recursion depth + circular detection. Required by §5.3 ("Sub-orchestration depth ≤ 3").
//
// We track a parent chain in-memory keyed by runId. Any spawn() that would exceed
// MAX_DEPTH or close a cycle throws synchronously.

const MAX_DEPTH = 3;

interface Edge {
  parentRunId: string;
}

const chain = new Map<string, Edge>();

export function registerRun(runId: string, parentRunId?: string): void {
  if (parentRunId) {
    if (chain.has(runId)) {
      throw new Error(`recursion: ${runId} already registered`);
    }
    if (depthOf(parentRunId) + 1 > MAX_DEPTH) {
      throw new Error(`recursion: depth would exceed ${MAX_DEPTH}`);
    }
    if (isAncestor(runId, parentRunId)) {
      throw new Error(`recursion: cycle detected (${runId} ↺ ${parentRunId})`);
    }
    chain.set(runId, { parentRunId });
  }
}

function depthOf(runId: string): number {
  let d = 0;
  let cur: string | undefined = runId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const edge = chain.get(cur);
    if (!edge) break;
    d++;
    cur = edge.parentRunId;
  }
  return d;
}

function isAncestor(maybeAncestor: string, runId: string): boolean {
  let cur: string | undefined = runId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === maybeAncestor) return true;
    seen.add(cur);
    cur = chain.get(cur)?.parentRunId;
  }
  return false;
}

export function clearDepth(): void {
  chain.clear();
}

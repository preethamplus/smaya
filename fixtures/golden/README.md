# Golden datasets

These are deterministic fixtures the behavior evals score against.

| File | Eval | Purpose |
|---|---|---|
| `pii-golden.json` | `PII_MASKING` | 5 raw resume snippets → expected mask tokens. 100% mask rate required to pass. The expected token values are derived from the SHA-256 truncation in `packages/shared/src/pii.ts` so any drift in the masker breaks the eval. |
| `bias-golden.json` | `LEADERBOARD_BIAS` | Synthetic group label per candidate (`group_x`/`group_y`). The orchestrator never sees these — they exist only for the eval to compute demographic parity (must fall in [0.8, 1.25]). |

`SCORE_STABILITY` does not need a golden file because it scores by self-consistency: it re-runs the LLM with the same `stableKey` twice and checks that top-6 is identical.

## Drift discipline

When the masker hash changes, regenerate `pii-golden.json` by:

```bash
node -e "const {tokenize,generalizeLocation}=require('./packages/shared/dist/pii.js'); /* recompute */"
```

…and commit a new file. The build log entry must include "regenerated PII golden tokens" so the diff is auditable.

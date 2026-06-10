# Benchmark

RagCode benchmarks are stored under `.ragcode/benchmarks/` so local runs do not pollute source control. Each run writes:

- `latest.json` - machine-readable latest report.
- `latest.md` - human-readable latest summary.
- `<timestamp>.matrix.json` and `<timestamp>.matrix.md` - multi-repo snapshots.
- `<timestamp>.benchmark.json` and `<timestamp>.benchmark.md` - ad-hoc single-repo snapshots.

## Repository Matrix

The default matrix is declared in `benchmarks/benchmark-repos.json`.

- `core` repos are the main optimization gate candidates.
- `observation` repos guard against overfitting to TypeScript/Vite patterns, but they are not assertion gates by default.
- `gate: true` cases are used by `--assert`; diagnostic cases still report pass/fail but do not fail the command unless they are marked as gates.

Default sample checkout root:

```text
..\ragcode-samples
```

You can override it without editing the config:

```powershell
$env:RAGCODE_BENCHMARK_SAMPLE_ROOT="D:\path\to\ragcode-samples"
```

Current configured repos:

| Suite | Repo | Purpose |
| --- | --- | --- |
| core | `vitejs/vite` | TypeScript toolchain, plugin lifecycle, docs/tests/fixtures pollution. |
| core | `honojs/hono` | Compact TypeScript routing, context, and middleware ownership. |
| core | `TanStack/query` | Multi-package TypeScript library with adapter/core owner split. |
| core | `shadcn-ui/ui` | CLI, registry, docs/examples, and schema-heavy TypeScript repo. |
| core | `payloadcms/payload` | Very large TypeScript CMS monorepo with operations/auth/config surfaces. |
| observation | `fastapi/fastapi` | Python routing, dependencies, OpenAPI, and response ownership. |
| observation | `gin-gonic/gin` | Go routing, middleware, context, binding, and render ownership. |
| observation | `tokio-rs/axum` | Rust routing, handlers, extractors, and rejection-heavy paths. |

The config pins the commit observed when the sample repos were cloned. Refreshing those pins should be a deliberate benchmark baseline update.

## Current Warmed Baseline

Checked on 2026-06-09 after the `core-owner-quality` pass.

The fast smoke gate is green:

```powershell
npm run benchmark:perf-smoke
```

Latest passing smoke evidence:

- repo: `hono`
- case: `hono-compose-middleware`
- indexReused: `true`
- gatePassed: `true`
- semanticFailedCases: `0`
- reportedElapsedMs: `3347ms`
- budget: `15000ms`

The focused Vite gate is green:

```powershell
bun run benchmark -- --repo-name vite --case vite-plugin-config --reuse-index --assert
```

Earlier passing owner ranks:

| Expected owner | Rank |
| --- | --- |
| `packages/vite/src/node/build.ts` | 3 |
| `packages/vite/src/node/server/pluginContainer.ts` | 4 |
| `packages/plugin-legacy/src/index.ts` | 5 |

Full warmed core is green:

```powershell
bun run benchmark -- --suite core --reuse-index --assert
```

Latest passing full-core evidence:

- repos: `5`
- cases: `10`
- gatedCases: `9`
- failedCases: `0`
- failedGatedCases: `0`
- gatePassed: `true`
- semanticFailedCases: `0`
- totalTopologyDuplicates: `0`
- totalOwnerSymbols: `69`
- maxSearchElapsedMs: `10831ms`
- maxContextElapsedMs: `10530ms`

Former owner-quality failures are now green:

| Repo | Case | Latest result |
| --- | --- | --- |
| `hono` | `hono-context-request` | `src/context.ts` rank 3 and `src/request.ts` rank 5, both <= 6. |
| `tanstack-query` | `tanstack-react-use-query` | `packages/query-core/src/queryObserver.ts` is inside the required top 6. |
| `tanstack-query` | `tanstack-query-cache-notify` | `packages/query-core/src/notifyManager.ts` is present. |
| `shadcn-ui` | `shadcn-add-registry-resolver` | `packages/shadcn/src/commands/add.ts` is present with `registry/resolver.ts`. |
| `payload` | warmed core participation | Persisted index is available and full core reuses it. |
| `vite` | `vite-resolve-plugins` | Diagnostic case passes with `plugins/index.ts` and `build.ts` inside top 4. |

## Benchmark-Driven Optimization Queue

The first `core-owner-quality` queue is complete. Use the next queue to protect that gain before adding deeper relation features.

1. Add negative owner-quality cases: same-name false positives, adapter/package noise, command/docs/example collisions, generic owner terms, and unrelated `index.ts` owners.
2. Add or promote observation-language gates only after baseline indexes are stable for Python/Go/Rust/Java repos.
3. Stress full warmed core with repeated `--reuse-index` runs and record variance for max search/context elapsed time.
4. Keep `scoreOwnerIntent` bounded by benchmark evidence; do not add more repo-specific boosts without matching negative cases.
5. After negative owner-quality is stable, choose the next product lane: watcher hardening, `coverageSummary`, `why_these_files`, `reuse_guard`, normalized duplicate detection, or weighted path search.

## Commands

List the selected benchmark matrix without indexing:

```powershell
bun run benchmark -- --list
```

Run the default core matrix:

```powershell
bun run benchmark
```

Run only observation repos:

```powershell
bun run benchmark -- --suite observation
```

Run core plus observation:

```powershell
bun run benchmark -- --all
```

Run one configured repo:

```powershell
bun run benchmark -- --repo-name hono
```

Run one configured case:

```powershell
bun run benchmark -- --repo-name vite --case vite-plugin-config
```

Run only gated cases:

```powershell
bun run benchmark -- --gate-only
```

Reuse an existing persisted index instead of rebuilding graph/LanceDB state:

```powershell
bun run benchmark -- --repo-name hono --case hono-compose-middleware --reuse-index
```

`--skip-index` is accepted as an alias for `--reuse-index`. This mode is intended for warmed local tuning loops. It fails if the repo has not already been indexed.

Run the warmed-index performance smoke gate:

```powershell
npm run benchmark:perf-smoke
```

The smoke gate currently runs the Hono middleware case with `--reuse-index`, requires the gated case and semantic diagnostics to pass, verifies the report used an existing index, and enforces a 15 second local wall-time budget. Use it for fast iteration before running broader matrix checks.

Run the matrix as a gate. This exits non-zero when any selected gated case fails:

```powershell
bun run benchmark:assert
```

Run against an ad-hoc repository with the legacy Vite cases:

```powershell
bun run benchmark -- --repo D:\path\to\repo
```

Legacy ad-hoc default when `--repo` is provided through env:

```powershell
$env:RAGCODE_BENCHMARK_REPO="D:\path\to\repo"
bun run benchmark -- --repo $env:RAGCODE_BENCHMARK_REPO
```

## Metrics

The report tracks:

- index scale and latency: files, chunks, symbols, edges, skipped files, elapsed time;
- runtime profile: graph store, semantic store, embedding provider/model, semantic warmup size;
- per-case search latency, top hits, and semantic participation;
- per-case context latency, owner files, owner symbols, snippets, relationships, and context budget use;
- implementation/test/docs/fixture owner counts;
- topology duplicate count;
- expected owner file ranks and missing owner files;
- gated-case pass/fail separate from diagnostic-case pass/fail.

## Reading Failures

A failed benchmark case means the current retrieval/context output missed a declared expectation, not necessarily that indexing crashed.

Common failure meanings:

- `missingOwnerFiles` is non-empty: retrieval did not surface expected owner files for that query.
- `ownerRanks` exceeds `maxRank`: the owner appeared but too low in the context owner chain.
- `topologyDuplicateCount > 0`: context topology returned duplicate edges.
- `ownerSymbolCount = 0`: owner chain has files but no symbol-level evidence.
- `semantic.status = failed`: semantic retrieval failed for that case.
- `semanticTopNParticipation = 0`: semantic retrieval returned raw hits but did not affect the fused top-N set.
- `usedChars > budgetChars`: context packing exceeded the requested budget.

Use `latest.md` for a fast review, then inspect `latest.json` for exact top hits and reasons.

## Gate Policy

Use `bun run benchmark` while iterating. Use `bun run benchmark:assert` when you want selected gated expectations to block completion or CI.

Known diagnostic case:

- `vite-resolve-plugins` is intentionally present with `gate: false`; it has been useful for showing tests/docs/fixtures outranking implementation owners. Keep it in the matrix so retrieval changes can show whether this improves without making the whole gate depend on this known failure.

# Benchmark

RagCode benchmarks are stored under `.ragcode/benchmarks/` so local runs do not pollute source control. Each run writes:

- `latest.json` - machine-readable report for comparison and automation.
- `latest.md` - human-readable summary for quick review.
- `<timestamp>.benchmark.json` and `<timestamp>.benchmark.md` - historical snapshots.

## Commands

Generate a report without failing the command:

```powershell
bun run benchmark
```

Run the benchmark as a gate. This exits non-zero when any asserted case fails:

```powershell
bun run benchmark:assert
```

Run one case against the default sample repo:

```powershell
bun run benchmark -- --case vite-plugin-config
```

Run against another indexed or indexable repository:

```powershell
bun run benchmark -- --repo D:\path\to\repo
```

## Default Sample

When `--repo` is omitted, the benchmark uses:

```text
..\ragcode-samples\vite
```

You can override this without passing CLI args:

```powershell
$env:RAGCODE_BENCHMARK_REPO="D:\path\to\repo"
bun run benchmark
```

## Metrics

The report tracks:

- index scale and latency: files, chunks, symbols, edges, skipped files, elapsed time;
- runtime profile: graph store, semantic store, embedding provider/model, semantic warmup size;
- per-case search latency and top hits;
- per-case context latency, owner files, owner symbols, snippets, relationships, and context budget use;
- topology duplicate count;
- expected owner files missing from the context pack;
- semantic participation count, currently detected through `LanceDB vector similarity match` in result reasons.

## Reading Failures

A failed benchmark case means the current retrieval/context output missed a declared expectation, not necessarily that indexing crashed.

Common failure meanings:

- `missingOwnerFiles` is non-empty: retrieval did not surface expected owner files for that query.
- `topologyDuplicateCount > 0`: context topology returned duplicate edges.
- `ownerSymbolCount = 0`: owner chain has files but no symbol-level evidence.
- `usedChars > budgetChars`: context packing exceeded the requested budget.

Use `latest.md` for a fast review, then inspect `latest.json` for exact top hits and reasons.

## Current Vite Cases

- `vite-plugin-config`: expected to pass after the owner-symbol and topology-dedupe fixes.
- `vite-resolve-plugins`: currently useful as a quality diagnostic; it shows tests/docs can outrank implementation owners for some plugin queries. Keep it in the report so retrieval changes can show whether this improves.

## Gate Policy

Use `bun run benchmark` while iterating. Use `bun run benchmark:assert` only when you want current asserted expectations to block completion or CI.

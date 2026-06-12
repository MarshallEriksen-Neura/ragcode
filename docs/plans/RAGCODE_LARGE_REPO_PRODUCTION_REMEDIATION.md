# RagCode Large-Repository Production Remediation Plan

## Target Result

RagCode should index large mixed-language repositories without failing on one bad parser input, without wasting default effort on dependency/build artifacts, and with user-facing evidence that separates graph index completion from optional semantic cache work.

## Evidence From Deeting

- Python virtualenv contents were scanned as source, raising the cold-start file count to roughly 15k files before `.venv` filtering reduced the active scan to roughly 4.6k files.
- Native tree-sitter parsers can throw `Invalid argument` for individual Python, Go, and Rust files on this Windows/Node runtime.
- Generated Next.js bundle files under `out/_next/static/chunks` produced duplicate short-name symbols such as `t`, `a`, and `r` on the same line, violating SQLite symbol primary-key assumptions.
- LanceDB may warn on `latest_version_hint.json` permissions after the graph index is already usable, so CLI output must not blur semantic-cache warnings with graph-index failure.

## Implementation Scope

1. Classification and ignore policy
   - Add deterministic file/path classification for source, test, config, docs, generated, vendor, build, minified, sensitive, and oversize files.
   - Keep ignored build/vendor/generated/minified artifacts out of default indexing.
   - Preserve explicit skipped-file reasons for status/freshness evidence.

2. Parser fault isolation
   - Keep tree-sitter parser failures scoped to one file.
   - Return fallback block chunks for failed parser files.
   - Aggregate parser fallback counts and samples instead of printing one noisy line per file.

3. Symbol/chunk integrity
   - Ensure returned and persisted `RepoIndex` data satisfies unique `chunk.id` and `symbol.id` invariants.
   - Prefer avoiding generated/minified artifacts before relying on dedupe.

4. CLI reporting
   - Include skipped-file count and analysis warning summaries in progress/completion output.
   - Preserve graph success when semantic indexing degrades.

## Tests

- Scanner/classification tests for `.venv`, `out/_next`, `*.min.js`, generated protobuf/mocks, and sensitive files.
- Analyzer fallback test for parser `Invalid argument` with aggregated warning metadata.
- Chunker/indexer test for duplicate analyzer output before graph persistence.
- CLI/progress-facing tests for skipped and analysis warning counts.

## Validation Gate

- `npm run check`
- `npm test -- tests/analyzer-registry.test.ts tests/foundation.test.ts tests/incremental-indexing.test.ts`
- `npm run build`
- `node dist/src/cli/index.js index D:/20260302170616/Deeting`

## Out Of Scope

- Adding new parser dependencies.
- Building full Kotlin/Scala/C/C++ analyzers.
- Changing LanceDB internals; warning behavior is surfaced and bounded, not patched upstream.

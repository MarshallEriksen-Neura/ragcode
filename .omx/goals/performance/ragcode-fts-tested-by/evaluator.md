# Performance Evaluator: ragcode-fts-tested-by

## Objective
Integrate two RagCode retrieval enhancements: SQLite FTS keyword retrieval with bm25/project isolation, and tested_by topology evidence through related_tests/impact/trace/topology flows

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when tests prove SQLite searchText uses chunks_fts MATCH with bm25/project isolation/stale replacement behavior, tested_by edges are indexed from co-located test imports, related_tests/impact/trace/topology expose those edges, and check/test/build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

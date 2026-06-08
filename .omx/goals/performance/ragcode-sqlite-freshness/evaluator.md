# Performance Evaluator: ragcode-sqlite-freshness

## Objective
Implement RagCode SQLite graph store with project-scoped freshness state and transactional per-file replacement

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when SQLite graph persistence, project isolation, freshness/skipped metadata, replacement reindex behavior, regression tests, strict typecheck, and production build all pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

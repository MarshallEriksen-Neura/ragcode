# Performance Evaluator: plan-stability-topology

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY starting with Phase 1 index freshness core, SQLite graph persistence, transactional per-file reindexing, and freshness-aware context packs

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, regression tests covering changed/deleted/ignored/stale freshness behavior, and production build pass after the Phase 1 stability implementation

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

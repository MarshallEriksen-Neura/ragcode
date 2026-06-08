# Performance Evaluator: plan-vector-consistency

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 2 semantic vector consistency with delete-before-upsert, project-scoped LanceDB filtering, generation metadata, and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, tests proving semantic delete-before-upsert, deleted-vector suppression, project isolation, missing LanceDB fallback behavior, and production build all pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

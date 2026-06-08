# Performance Evaluator: plan-import-resolution

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 3 TypeScript import/export resolution with resolved cross-file call edges and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, tests proving relative import resolution, imported call edges resolve to real symbol IDs, impact analysis includes cross-file callers, trace_flow crosses file boundaries, and production build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

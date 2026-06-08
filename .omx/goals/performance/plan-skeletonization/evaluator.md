# Performance Evaluator: plan-skeletonization

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 7 skeletonization and context shaping with expansion policy, snippet renderer, line elision metadata, and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, tests proving large implementation chunks default to skeleton, precise query returns focused body window, elided/returned line counts are accurate, existing context behavior stays stable, and production build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

# Performance Evaluator: plan-evaluation-harness

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 9 evaluation harness with reusable fixtures, scenario metrics, eval tests, and a scriptable context evaluator

## Evaluator Command
```sh
bun run eval:context && bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when eval fixtures and tests prove deleted/stale files are rejected, payment flow includes service and webhook nodes, unresolved edge count is reported, large unrelated files are not returned in full, graph-proximate owners outrank disconnected semantic matches, and check/test/build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

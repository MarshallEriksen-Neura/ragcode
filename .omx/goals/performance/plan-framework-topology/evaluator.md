# Performance Evaluator: plan-framework-topology

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 5 framework topology detection for React static API calls, Next.js API routes, service routing edges, webhook recognition, and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, tests proving React fetch to API route topology, API route to service edge, webhook route recognition, context topology evidence, trace_flow framework edges, and production build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

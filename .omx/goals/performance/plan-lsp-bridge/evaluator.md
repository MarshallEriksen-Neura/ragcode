# Performance Evaluator: plan-lsp-bridge

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 4 TypeScript Language Service bridge for definition-based call resolution, reference-aware impact, graceful fallback, and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, tests proving LSP definition resolution for unresolved calls, trace_flow exposes LSP target files, impact_analysis includes LSP-resolved callers, unresolved calls remain explicit, LSP failures degrade to AST graph, and production build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

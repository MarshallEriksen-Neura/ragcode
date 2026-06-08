# Performance Evaluator: plan-agent-tools

## Objective
Implement PLAN_STABILITY_AND_TOPOLOGY Phase 6 agent tool upgrades with topology_map, index_status, refresh_index, typed engine contracts, MCP handlers, and regression tests

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when TypeScript check, tests proving topology_map returns owner/topology evidence, index_status reports freshness counts, refresh_index clears stale/pending state, MCP tool definitions/handlers expose the new tools, and production build pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

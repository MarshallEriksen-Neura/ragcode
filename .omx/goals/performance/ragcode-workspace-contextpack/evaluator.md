# Performance Evaluator: ragcode-workspace-contextpack

## Objective
Implement RagCode plan phase 0 foundation: workspace auto-scope, project isolation, sensitive-file policy, and final ContextPack shape

## Evaluator Command
```sh
bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when workspace/project isolation, sensitive filtering, final ContextPack shape, regression tests, strict typecheck, and production build all pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

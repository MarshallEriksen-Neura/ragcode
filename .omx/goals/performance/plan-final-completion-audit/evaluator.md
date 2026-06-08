# Performance Evaluator: plan-final-completion-audit

## Objective
Complete PLAN_STABILITY_AND_TOPOLOGY final audit by mapping every completion definition item to executable evidence, adding an audit script and report, and verifying the full evaluator

## Evaluator Command
```sh
bun run audit:plan && bun run eval:context && bun run check && bun run test && bun run build
```

## Pass/Fail Contract
PASS when the final audit script proves every PLAN_STABILITY_AND_TOPOLOGY completion definition item has executable evidence, emits a stable report, and audit/eval/check/test/build all pass

This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.

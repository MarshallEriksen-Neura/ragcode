import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { WizardState, WizardStep } from "./state.js";
import { answerCurrentStep, cancelWizard, currentStep } from "./state.js";

export interface ConfigureAppProps {
  initialState: WizardState;
  onFinish: (state: WizardState) => void;
}

// Pure rendering layer over the wizard state machine. All flow decisions live in state.ts;
// this component only translates keystrokes into answerCurrentStep/cancelWizard calls.
export function ConfigureApp({ initialState, onFinish }: ConfigureAppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const step = currentStep(state);

  const submit = (value: string): void => {
    const next = answerCurrentStep(state, value);
    setState(next);
    if (next.done) {
      onFinish(next);
      exit();
    }
  };

  const cancel = (): void => {
    const next = cancelWizard(state);
    setState(next);
    onFinish(next);
    exit();
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        {state.mode === "first_run" ? "🧙 RagCode First-Run Setup" : "🛠  RagCode Configure"}
      </Text>
      <Text dimColor>repo: {state.repoRoot}   (Esc cancels)</Text>
      <AnsweredSummary state={state} />
      {step ? <StepView key={step.key} step={step} onSubmit={submit} onCancel={cancel} /> : null}
    </Box>
  );
}

function AnsweredSummary({ state }: { state: WizardState }): React.ReactElement {
  const answered = state.steps.filter((step) => state.answers[step.key] !== undefined && !step.skip?.(state.answers));
  return (
    <Box flexDirection="column" marginTop={1}>
      {answered.map((step) => (
        <Text key={step.key} dimColor>
          ✓ {step.title}: {step.secret ? (state.answers[step.key] ? "<set>" : "<unchanged>") : state.answers[step.key]}
        </Text>
      ))}
    </Box>
  );
}

function StepView({ step, onSubmit, onCancel }: { step: WizardStep; onSubmit: (value: string) => void; onCancel: () => void }): React.ReactElement {
  if (step.kind === "select") return <SelectStep step={step} onSubmit={onSubmit} onCancel={onCancel} />;
  if (step.kind === "confirm") return <ConfirmStep step={step} onSubmit={onSubmit} onCancel={onCancel} />;
  return <TextStep step={step} onSubmit={onSubmit} onCancel={onCancel} />;
}

function SelectStep({ step, onSubmit, onCancel }: { step: WizardStep; onSubmit: (value: string) => void; onCancel: () => void }): React.ReactElement {
  const options = step.options ?? [];
  const defaultIndex = Math.max(0, options.findIndex((option) => option.value === step.defaultValue));
  const [cursor, setCursor] = useState(defaultIndex);

  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) setCursor((index) => (index - 1 + options.length) % options.length);
    if (key.downArrow) setCursor((index) => (index + 1) % options.length);
    if (key.return) onSubmit(options[cursor]?.value ?? step.defaultValue);
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{step.title}</Text>
      {options.map((option, index) => (
        <Text key={option.value} color={index === cursor ? "green" : undefined}>
          {index === cursor ? "❯ " : "  "}
          {option.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ to choose, Enter to confirm</Text>
    </Box>
  );
}

function ConfirmStep({ step, onSubmit, onCancel }: { step: WizardStep; onSubmit: (value: string) => void; onCancel: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (input.toLowerCase() === "y") return onSubmit("yes");
    if (input.toLowerCase() === "n") return onSubmit("no");
    if (key.return) onSubmit(step.defaultValue);
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{step.title}</Text>
      <Text dimColor>y/n, Enter = {step.defaultValue}</Text>
    </Box>
  );
}

function TextStep({ step, onSubmit, onCancel }: { step: WizardStep; onSubmit: (value: string) => void; onCancel: () => void }): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit(value);
    if (key.backspace || key.delete) return setValue((current) => current.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setValue((current) => current + input);
  });

  const display = step.secret ? "*".repeat(value.length) : value;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{step.title}</Text>
      <Text>
        {"> "}
        {display}
        <Text inverse> </Text>
      </Text>
      {step.defaultValue ? <Text dimColor>Enter keeps: {step.secret ? "<existing>" : step.defaultValue}</Text> : <Text dimColor>Enter to skip</Text>}
    </Box>
  );
}

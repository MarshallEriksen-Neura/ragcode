import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-framework-"));
  await fs.mkdir(path.join(tempRoot, "src", "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "app", "api", "payments"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "app", "api", "stripe", "webhook"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "services"), { recursive: true });

  await fs.writeFile(
    path.join(tempRoot, "src", "app", "checkout", "CheckoutButton.tsx"),
    [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/payments', { method: 'POST' });",
      "  }",
      "  return <button onClick={onClick}>Pay</button>;",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "app", "api", "payments", "route.ts"),
    [
      "import { createPaymentIntent } from '../../../services/billing';",
      "",
      "export async function POST() {",
      "  return createPaymentIntent();",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "app", "api", "stripe", "webhook", "route.ts"),
    [
      "export async function POST() {",
      "  return new Response('ok');",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.ts"),
    [
      "export function createPaymentIntent() {",
      "  return { clientSecret: 'payment-intent-secret' };",
      "}"
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("framework topology detection", () => {
  it("links React static fetch calls to Next.js API route handlers", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    const apiEdge = index.edges.find((edge) => edge.kind === "calls_api");

    expect(apiEdge).toMatchObject({
      metadata: {
        framework: "nextjs",
        sourceFile: "src/app/checkout/CheckoutButton.tsx",
        targetFile: "src/app/api/payments/route.ts",
        route: "/api/payments",
        targetName: "POST",
        resolution: "framework_static"
      }
    });
  });

  it("derives API route to service topology from resolved call graph", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    const serviceEdge = index.edges.find((edge) => edge.kind === "routes_to" && edge.metadata?.targetName === "createPaymentIntent");

    expect(serviceEdge).toMatchObject({
      metadata: {
        framework: "nextjs",
        sourceFile: "src/app/api/payments/route.ts",
        targetFile: "src/services/billing.ts",
        route: "/api/payments",
        targetName: "createPaymentIntent",
        resolution: "framework_call_graph"
      }
    });
  });

  it("recognizes webhook API routes as webhook handlers", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    const webhookEdge = index.edges.find((edge) => edge.kind === "handles_webhook");

    expect(webhookEdge).toMatchObject({
      metadata: {
        framework: "nextjs",
        sourceFile: "src/app/api/stripe/webhook/route.ts",
        targetFile: "src/app/api/stripe/webhook/route.ts",
        route: "/api/stripe/webhook",
        targetName: "POST",
        resolution: "framework_static"
      }
    });
  });

  it("surfaces framework edges in trace flow and context topology", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const clientFlow = await engine.traceFlow(tempRoot, "CheckoutButton");
    expect(clientFlow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/app/checkout/CheckoutButton.tsx",
        kind: "calls_api",
        targetName: "POST",
        targetFile: "src/app/api/payments/route.ts"
      })
    ]));

    const routeFlow = await engine.traceFlow(tempRoot, "POST");
    expect(routeFlow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/app/api/payments/route.ts",
        kind: "routes_to",
        targetName: "createPaymentIntent",
        targetFile: "src/services/billing.ts"
      })
    ]));

    const pack = await engine.getContext({ repoRoot: tempRoot, query: "checkout payment api billing", budgetChars: 6000 });
    expect(pack.topology).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "src/app/checkout/CheckoutButton.tsx",
        to: "/api/payments",
        edge: "calls_api",
        targetFile: "src/app/api/payments/route.ts",
        confidence: "high"
      }),
      expect.objectContaining({
        from: "src/app/api/payments/route.ts",
        edge: "routes_to",
        targetFile: "src/services/billing.ts",
        confidence: "high"
      })
    ]));
  });
});

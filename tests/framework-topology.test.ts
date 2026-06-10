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
  await fs.mkdir(path.join(tempRoot, "src", "server"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "services"), { recursive: true });

  await fs.writeFile(
    path.join(tempRoot, "src", "app", "checkout", "CheckoutButton.tsx"),
    [
      "\"use client\";",
      "",
      "export function CheckoutButton() {",
      "  async function onClick() {",
      "    await fetch('/api/payments', { method: 'POST' });",
      "    await fetch('/api/orders', { method: 'POST' });",
      "    await fetch('/api/fast-orders');",
      "    const apiRoot = '/api';",
      "    const resource = 'dynamic-orders';",
      "    const dynamicOrderPath = `${apiRoot}/${resource}`;",
      "    await fetch(dynamicOrderPath);",
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
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "orders.ts"),
    [
      "import { orders } from '../db/schema';",
      "",
      "export async function createOrder() {",
      "  await prisma.order.create({ data: { total: 42 } });",
      "  await db.insert(orders).values({ id: 1 });",
      "  return { ok: true };",
      "}",
      "",
      "export async function listOrders() {",
      "  const existing = await prisma.order.findMany();",
      "  const rows = await db.select().from(orders);",
      "  return { existing, rows };",
      "}"
    ].join("\n")
  );
  await fs.mkdir(path.join(tempRoot, "src", "db"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "src", "db", "schema.ts"), "export const orders = {};\n");
  await fs.writeFile(
    path.join(tempRoot, "src", "server", "express.ts"),
    [
      "import express from 'express';",
      "import { createOrder } from '../services/orders';",
      "",
      "const app = express();",
      "app.post('/api/orders', createOrder);",
      "app.get('/api/dynamic-orders', createOrder);",
      "export { app };"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "server", "fastify.ts"),
    [
      "import fastify from 'fastify';",
      "import { listOrders } from '../services/orders';",
      "",
      "const app = fastify();",
      "app.get('/api/fast-orders', listOrders);",
      "export { app };"
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

  it("links client calls to Express and Fastify route resolver plugins", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "calls_api",
        metadata: expect.objectContaining({
          framework: "express",
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          targetFile: "src/services/orders.ts",
          route: "/api/orders",
          targetName: "createOrder",
          resolution: "framework_static"
        })
      }),
      expect.objectContaining({
        kind: "calls_api",
        metadata: expect.objectContaining({
          framework: "fastify",
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          targetFile: "src/services/orders.ts",
          route: "/api/fast-orders",
          targetName: "listOrders",
          resolution: "framework_static"
        })
      })
    ]));
  });

  it("resolves const/template API URL dataflow to concrete framework routes", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "calls_api",
        metadata: expect.objectContaining({
          framework: "express",
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          targetFile: "src/services/orders.ts",
          route: "/api/dynamic-orders",
          requestPath: "/api/dynamic-orders",
          targetName: "createOrder",
          resolution: "framework_dataflow"
        })
      })
    ]));
  });

  it("does not connect unresolved template API URLs as concrete routes", async () => {
    await fs.writeFile(
      path.join(tempRoot, "src", "app", "checkout", "CheckoutButton.tsx"),
      [
        "\"use client\";",
        "",
        "export function CheckoutButton({ slug }: { slug: string }) {",
        "  async function onClick() {",
        "    await fetch(`/api/${slug}`);",
        "  }",
        "  return <button onClick={onClick}>Pay</button>;",
        "}"
      ].join("\n")
    );

    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "calls_api",
        metadata: expect.objectContaining({
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          resolution: "framework_template"
        })
      })
    ]));
  });

  it("preserves Express/Fastify route catalogs during incremental client refreshes", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    await fs.writeFile(
      path.join(tempRoot, "src", "app", "checkout", "CheckoutButton.tsx"),
      [
        "\"use client\";",
        "",
        "export function CheckoutButton() {",
        "  async function onClick() {",
        "    await fetch('/api/orders', { method: 'POST' });",
        "    await fetch('/api/fast-orders');",
        "  }",
        "  return <button onClick={onClick}>Pay</button>;",
        "}"
      ].join("\n")
    );
    const index = await engine.indexRepo(tempRoot);

    expect(index.changedFiles).toEqual(["src/app/checkout/CheckoutButton.tsx"]);
    expect(index.refreshedFiles).toEqual(["src/app/checkout/CheckoutButton.tsx"]);
    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "calls_api",
        metadata: expect.objectContaining({
          framework: "express",
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          targetFile: "src/services/orders.ts",
          route: "/api/orders"
        })
      }),
      expect.objectContaining({
        kind: "calls_api",
        metadata: expect.objectContaining({
          framework: "fastify",
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          targetFile: "src/services/orders.ts",
          route: "/api/fast-orders"
        })
      })
    ]));
  });

  it("emits provider-specific Prisma and Drizzle ORM resource edges", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "writes_to",
        metadata: expect.objectContaining({
          orm: "prisma",
          sourceFile: "src/services/orders.ts",
          resource: "prisma.order",
          model: "order",
          operation: "create",
          resolution: "orm_static"
        })
      }),
      expect.objectContaining({
        kind: "reads_from",
        metadata: expect.objectContaining({
          orm: "prisma",
          sourceFile: "src/services/orders.ts",
          resource: "prisma.order",
          model: "order",
          operation: "findMany",
          resolution: "orm_static"
        })
      }),
      expect.objectContaining({
        kind: "writes_to",
        metadata: expect.objectContaining({
          orm: "drizzle",
          sourceFile: "src/services/orders.ts",
          resource: "drizzle.orders",
          model: "orders",
          operation: "insert",
          resolution: "orm_static"
        })
      }),
      expect.objectContaining({
        kind: "reads_from",
        metadata: expect.objectContaining({
          orm: "drizzle",
          sourceFile: "src/services/orders.ts",
          resource: "drizzle.orders",
          model: "orders",
          operation: "select",
          resolution: "orm_static"
        })
      })
    ]));
  });

  it("marks direct request payload ORM writes as bounded dataflow evidence", async () => {
    await fs.writeFile(
      path.join(tempRoot, "src", "services", "orders.ts"),
      [
        "export async function createOrder(req: Request) {",
        "  await prisma.order.create({ data: req.body });",
        "  await db.insert(orders).values(await req.json());",
        "}"
      ].join("\n")
    );

    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "writes_to",
        metadata: expect.objectContaining({
          orm: "prisma",
          resolution: "orm_dataflow",
          dataflowSource: "req.body",
          dataflowKind: "request_payload"
        })
      }),
      expect.objectContaining({
        kind: "writes_to",
        metadata: expect.objectContaining({
          orm: "drizzle",
          resolution: "orm_dataflow",
          dataflowSource: "req.json()",
          dataflowKind: "request_payload"
        })
      })
    ]));
  });
});

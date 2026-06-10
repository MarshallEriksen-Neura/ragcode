import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-runtime-topology-"));
  await fs.mkdir(path.join(tempRoot, "src", "app", "api", "billing"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "services"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "middleware.ts"),
    [
      "export function middleware() {",
      "  return Response.next();",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "app", "api", "billing", "route.ts"),
    [
      "import { loadInvoice } from '../../../../services/billing';",
      "",
      "export async function POST() {",
      "  return loadInvoice('inv_123');",
      "}"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "services", "billing.ts"),
    [
      "export function loadInvoice(invoiceId: string) {",
      "  const invoice = db.invoices.findUnique({ where: { id: invoiceId } });",
      "  db.auditLogs.create({ data: { invoiceId } });",
      "  eventBus.on('invoice.paid', handleInvoicePaid);",
      "  return invoice;",
      "}",
      "",
      "export function handleInvoicePaid() {",
      "  return true;",
      "}",
      "",
      "export async function saveInvoiceRequest(request: Request) {",
      "  const payload = await request.json();",
      "  return prisma.invoice.create({ data: payload });",
      "}"
    ].join("\n")
  );
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("runtime topology edges", () => {
  it("indexes resource, event, and middleware edges without using related", async () => {
    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);

    expect(index.edges.some((edge) => edge.kind === "related")).toBe(false);
    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "reads_from",
        metadata: expect.objectContaining({
          sourceFile: "src/services/billing.ts",
          targetName: "db.invoices",
          operation: "findUnique",
          resolution: "resource_static"
        })
      }),
      expect.objectContaining({
        kind: "writes_to",
        metadata: expect.objectContaining({
          sourceFile: "src/services/billing.ts",
          targetName: "db.auditLogs",
          operation: "create",
          resolution: "resource_static"
        })
      }),
      expect.objectContaining({
        kind: "handles_event",
        metadata: expect.objectContaining({
          sourceFile: "src/services/billing.ts",
          targetName: "invoice.paid",
          operation: "on",
          resolution: "event_static"
        })
      }),
      expect.objectContaining({
        kind: "uses_middleware",
        metadata: expect.objectContaining({
          sourceFile: "src/app/api/billing/route.ts",
          targetFile: "src/middleware.ts",
          targetName: "middleware",
          resolution: "framework_static"
        })
      }),
      expect.objectContaining({
        kind: "writes_to",
        metadata: expect.objectContaining({
          orm: "prisma",
          sourceFile: "src/services/billing.ts",
          resource: "prisma.invoice",
          operation: "create",
          dataflowSource: "payload",
          dataflowKind: "request_payload",
          resolution: "orm_dataflow"
        })
      })
    ]));
  });

  it("surfaces runtime edges through trace and topology map", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const serviceFlow = await engine.traceFlow(tempRoot, "loadInvoice");
    expect(serviceFlow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/services/billing.ts",
        kind: "reads_from",
        targetName: "db.invoices"
      }),
      expect.objectContaining({
        filePath: "src/services/billing.ts",
        kind: "writes_to",
        targetName: "db.auditLogs"
      }),
      expect.objectContaining({
        filePath: "src/services/billing.ts",
        kind: "handles_event",
        targetName: "invoice.paid"
      })
    ]));

    const routeFlow = await engine.traceFlow(tempRoot, "POST");
    expect(routeFlow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "src/app/api/billing/route.ts",
        kind: "uses_middleware",
        targetFile: "src/middleware.ts"
      })
    ]));

    const topology = await engine.topologyMap({
      repoRoot: tempRoot,
      query: "loadInvoice invoices auditLogs invoice paid middleware billing",
      maxEdges: 16
    });
    expect(topology.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge: "reads_from", to: "db.invoices" }),
      expect.objectContaining({ edge: "writes_to", to: "db.auditLogs" }),
      expect.objectContaining({ edge: "handles_event", to: "invoice.paid" }),
      expect.objectContaining({ edge: "uses_middleware", targetFile: "src/middleware.ts" })
    ]));
  });
});

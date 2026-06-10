import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine } from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-disambiguation-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("same-name symbol disambiguation", () => {
  it("limits impact to the file-qualified symbol instead of all same-name symbols", async () => {
    await writeFiles({
      "src/auth/session.ts": [
        "export function validate() {",
        "  return checkToken();",
        "}",
        "",
        "function checkToken() {",
        "  return true;",
        "}"
      ],
      "src/auth/use-session.ts": [
        "import { validate } from './session';",
        "",
        "export function requireSession() {",
        "  return validate();",
        "}"
      ],
      "src/payment/receipt.ts": [
        "export function validate() {",
        "  return checkAmount();",
        "}",
        "",
        "function checkAmount() {",
        "  return true;",
        "}"
      ],
      "src/payment/use-receipt.ts": [
        "import { validate } from './receipt';",
        "",
        "export function requireReceipt() {",
        "  return validate();",
        "}"
      ],
      "src/form/validator.ts": [
        "export function validate() {",
        "  return checkFields();",
        "}",
        "",
        "function checkFields() {",
        "  return true;",
        "}"
      ],
      "src/form/use-validator.ts": [
        "import { validate } from './validator';",
        "",
        "export function requireValidForm() {",
        "  return validate();",
        "}"
      ]
    });

    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const broadImpact = await engine.impactAnalysis(tempRoot, "validate");
    expect(broadImpact.matchedSymbols.filter((symbol) => symbol.name === "validate")).toHaveLength(3);

    const authImpact = await engine.impactAnalysis(tempRoot, "src/auth/session.ts:validate");
    expect(authImpact.matchedSymbols).toEqual([
      expect.objectContaining({ filePath: "src/auth/session.ts", name: "validate" })
    ]);
    expect(authImpact.impactedFiles).toEqual(expect.arrayContaining(["src/auth/session.ts", "src/auth/use-session.ts"]));
    expect(authImpact.impactedFiles).not.toContain("src/payment/receipt.ts");
    expect(authImpact.impactedFiles).not.toContain("src/payment/use-receipt.ts");
    expect(authImpact.impactedFiles).not.toContain("src/form/validator.ts");
    expect(authImpact.impactedFiles).not.toContain("src/form/use-validator.ts");
  });
});

describe("API wrapper and dynamic URL topology", () => {
  it("links axios, resolved local clients, and generated clients to Next.js routes while leaving unresolved templates unlinked", async () => {
    await writeFiles({
      "src/app/checkout/CheckoutButton.tsx": [
        "\"use client\";",
        "import axios from 'axios';",
        "import { api } from '../../lib/api-client';",
        "import { paymentsApi } from '../../generated/api-client';",
        "",
        "export function CheckoutButton({ userId }: { userId: string }) {",
        "  async function onClick() {",
        "    await axios.post('/api/payments', { amount: 100 });",
        "    await fetch(`/api/users/${userId}/profile`);",
        "    await api.payments.create({ amount: 100 });",
        "    await paymentsApi.createPayment({ amount: 100 });",
        "  }",
        "  return <button onClick={onClick}>Pay</button>;",
        "}"
      ],
      "src/lib/api-client.ts": [
        "export const api = {",
        "  payments: {",
        "    create(data: unknown) {",
        "      return data;",
        "    }",
        "  }",
        "};"
      ],
      "src/generated/api-client.ts": [
        "export const paymentsApi = {",
        "  createPayment(data: unknown) {",
        "    return data;",
        "  }",
        "};"
      ],
      "src/app/api/payments/route.ts": [
        "export async function POST() {",
        "  return Response.json({ ok: true });",
        "}"
      ],
      "src/app/api/users/[userId]/profile/route.ts": [
        "export async function GET() {",
        "  return Response.json({ ok: true });",
        "}"
      ]
    });

    const engine = new RagCodeEngine();
    const index = await engine.indexRepo(tempRoot);
    const apiEdges = index.edges.filter((edge) => edge.kind === "calls_api");

    expect(apiEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          sourceFile: "src/app/checkout/CheckoutButton.tsx",
          targetFile: "src/app/api/payments/route.ts",
          route: "/api/payments",
          requestPath: "/api/payments",
          resolution: "framework_wrapper"
        })
      }),
    ]));

    expect(apiEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          targetFile: "src/app/api/users/[userId]/profile/route.ts",
          route: "/api/users/:userId/profile",
          resolution: "framework_template"
        })
      })
    ]));

    const paymentEdges = apiEdges.filter((edge) => edge.metadata?.route === "/api/payments");
    expect(paymentEdges).toHaveLength(3);
  });
});

async function writeFiles(files: Record<string, string[]>): Promise<void> {
  for (const [filePath, lines] of Object.entries(files)) {
    const absolutePath = path.join(tempRoot, ...filePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, lines.join("\n"));
  }
}

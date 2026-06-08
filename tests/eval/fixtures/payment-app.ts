import fs from "node:fs/promises";
import path from "node:path";

export interface PaymentEvalFixture {
  checkoutFile: string;
  routeFile: string;
  serviceFile: string;
  webhookFile: string;
  relatedTestFile: string;
  disconnectedDocFile: string;
  disconnectedMockFile: string;
  largeFile: string;
  staleFile: string;
  deletedFile: string;
}

export async function createPaymentEvalFixture(root: string): Promise<PaymentEvalFixture> {
  await fs.mkdir(path.join(root, "src", "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "app", "api", "payments"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "app", "api", "stripe", "webhook"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "services"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "mocks"), { recursive: true });
  await fs.mkdir(path.join(root, "docs"), { recursive: true });

  const fixture: PaymentEvalFixture = {
    checkoutFile: "src/app/checkout/CheckoutButton.tsx",
    routeFile: "src/app/api/payments/route.ts",
    serviceFile: "src/services/billing.ts",
    webhookFile: "src/app/api/stripe/webhook/route.ts",
    relatedTestFile: "src/services/billing.test.ts",
    disconnectedDocFile: "docs/payment-playbook.md",
    disconnectedMockFile: "src/mocks/payment-copy.json",
    largeFile: "src/services/large-payment-ledger.ts",
    staleFile: "src/services/stale-cache.ts",
    deletedFile: "src/services/obsolete-payment-cache.ts"
  };

  await fs.writeFile(path.join(root, fixture.checkoutFile), checkoutSource());
  await fs.writeFile(path.join(root, fixture.routeFile), routeSource());
  await fs.writeFile(path.join(root, fixture.serviceFile), serviceSource());
  await fs.writeFile(path.join(root, fixture.webhookFile), webhookSource());
  await fs.writeFile(path.join(root, fixture.relatedTestFile), relatedTestSource());
  await fs.writeFile(path.join(root, fixture.disconnectedDocFile), "payment checkout billing ".repeat(100));
  await fs.writeFile(path.join(root, fixture.disconnectedMockFile), JSON.stringify({ text: "payment checkout billing ".repeat(60) }));
  await fs.writeFile(path.join(root, fixture.largeFile), largePaymentLedgerSource());
  await fs.writeFile(path.join(root, fixture.staleFile), staleCacheSource("indexed-stale-cache-marker"));
  await fs.writeFile(path.join(root, fixture.deletedFile), deletedCacheSource());

  return fixture;
}

export function changedStaleCacheSource(): string {
  return staleCacheSource("changed-stale-cache-marker");
}

function checkoutSource(): string {
  return [
    "\"use client\";",
    "",
    "export function CheckoutButton() {",
    "  async function onClick() {",
    "    await fetch('/api/payments', { method: 'POST' });",
    "  }",
    "  return <button onClick={onClick}>Checkout</button>;",
    "}"
  ].join("\n");
}

function routeSource(): string {
  return [
    "import { createPaymentIntent } from '../../../services/billing';",
    "",
    "export async function POST() {",
    "  recordUnresolvedPaymentTelemetry('payment checkout billing');",
    "  return createPaymentIntent();",
    "}"
  ].join("\n");
}

function serviceSource(): string {
  return [
    "export function createPaymentIntent() {",
    "  return { clientSecret: 'payment-intent-secret', owner: 'BillingService' };",
    "}"
  ].join("\n");
}

function webhookSource(): string {
  return [
    "export async function POST() {",
    "  const eventType = 'stripe payment webhook billing';",
    "  return new Response(eventType);",
    "}"
  ].join("\n");
}

function relatedTestSource(): string {
  return [
    "import { expect, it } from 'vitest';",
    "import { createPaymentIntent } from './billing';",
    "",
    "it('creates a payment intent for billing', () => {",
    "  expect(createPaymentIntent().clientSecret).toContain('payment');",
    "});"
  ].join("\n");
}

function largePaymentLedgerSource(): string {
  const lines = [
    "export function largePaymentLedger(input: { amount: number }) {",
    "  const events: string[] = new Array(170);",
    "  events[0] = 'payment ledger architecture start';"
  ];
  for (let index = 0; index < 160; index += 1) {
    lines.push(`  events[${index + 1}] = 'payment ledger architecture step ${index}';`);
    if (index === 120) lines.push("  events[165] = 'TARGET_LEDGER_RECONCILIATION_MARKER';");
  }
  lines.push("  return events.join('\\n');");
  lines.push("}");
  return lines.join("\n");
}

function staleCacheSource(marker: string): string {
  return [
    "export function stalePaymentCache() {",
    `  return '${marker}';`,
    "}"
  ].join("\n");
}

function deletedCacheSource(): string {
  return [
    "export function obsoletePaymentCache() {",
    "  return 'obsolete-payment-cache-marker';",
    "}"
  ].join("\n");
}

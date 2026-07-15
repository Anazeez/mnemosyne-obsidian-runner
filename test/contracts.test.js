import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseWorkOrder } from "../src/contracts.js";

const fixtureUrl = new URL("./fixtures/work-order-v1.md", import.meta.url);
const fixture = await readFile(fileURLToPath(fixtureUrl), "utf8");

test("accepts the plugin-emitted v1 work order", () => {
  const order = parseWorkOrder(fixture);

  assert.equal(order.schema, "ariadne.work-order/v1");
  assert.equal(order.id, "ariadne-7a1e0e9c31c419e95b05b003");
  assert.equal(order.operation, "incorporate_note");
  assert.equal(order.status, "queued");
  assert.deepEqual(order.allowedDomains, ["knowledge"]);
  assert.equal(order.capture.content, "# Stable note\n\nThis is approved.");
});

test("rejects unsupported schemas", () => {
  assert.throws(
    () => parseWorkOrder(fixture.replace("ariadne.work-order/v1", "ariadne.work-order/v2")),
    (error) => error.code === "invalid_work_order"
  );
});

test("rejects source traversal", () => {
  assert.throws(
    () => parseWorkOrder(fixture.replaceAll("Inbox/Stable.md", "../Stable.md")),
    (error) => error.code === "invalid_work_order"
  );
});

test("rejects source hash mismatches", () => {
  assert.throws(
    () => parseWorkOrder(fixture.replace(
      "This is approved.",
      "This content no longer matches the approved hash."
    )),
    (error) => error.code === "invalid_work_order"
  );
});

test("rejects deterministic job ID mismatches", () => {
  assert.throws(
    () => parseWorkOrder(fixture.replace(
      "ariadne-7a1e0e9c31c419e95b05b003",
      "ariadne-000000000000000000000000"
    )),
    (error) => error.code === "invalid_work_order"
  );
});

test("rejects domains other than knowledge", () => {
  assert.throws(
    () => parseWorkOrder(fixture.replace("allowed_domains: knowledge", "allowed_domains: files")),
    (error) => error.code === "invalid_work_order"
  );
});

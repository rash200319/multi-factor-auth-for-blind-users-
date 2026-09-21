import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run } from "../src/db/index.js";
import { issueStepUpCode, verifyAndConsumeStepUpCode, confirmStepUpCodeCapture, generateStepUpCode } from "../src/services/stepupCode.js";

function makeUser(): string {
  const id = randomUUID();
  run("INSERT INTO users (id, display_name, email, status) VALUES (?, ?, ?, 'ACTIVE')", [id, "Test User", `${id}@example.test`]);
  return id;
}

test("generateStepUpCode produces three hyphen-separated words", () => {
  const code = generateStepUpCode();
  const parts = code.split("-");
  assert.equal(parts.length, 3);
  for (const part of parts) assert.ok(part.length > 0);
});

test("a freshly issued code verifies once and is then rejected (single use)", async () => {
  const userId = makeUser();
  const { code } = await issueStepUpCode(userId);

  const first = await verifyAndConsumeStepUpCode(userId, code);
  assert.equal(first, "ok");

  const second = await verifyAndConsumeStepUpCode(userId, code);
  assert.equal(second, "already_consumed");
});

test("a wrong code is rejected without consuming the real one", async () => {
  const userId = makeUser();
  const { code } = await issueStepUpCode(userId);

  const wrong = await verifyAndConsumeStepUpCode(userId, "not-the-right-code");
  assert.equal(wrong, "mismatch");

  const right = await verifyAndConsumeStepUpCode(userId, code);
  assert.equal(right, "ok");
});

test("confirmStepUpCodeCapture matches without consuming the code", async () => {
  const userId = makeUser();
  const { code } = await issueStepUpCode(userId);

  const captured = await confirmStepUpCodeCapture(userId, code);
  assert.equal(captured, true);

  // Still consumable afterwards — capture-confirmation must not spend it.
  const result = await verifyAndConsumeStepUpCode(userId, code);
  assert.equal(result, "ok");
});

test("issuing a new code invalidates any prior unconsumed one", async () => {
  const userId = makeUser();
  const first = await issueStepUpCode(userId);
  const second = await issueStepUpCode(userId);

  const staleResult = await verifyAndConsumeStepUpCode(userId, first.code);
  assert.equal(staleResult, "mismatch");

  const freshResult = await verifyAndConsumeStepUpCode(userId, second.code);
  assert.equal(freshResult, "ok");
});

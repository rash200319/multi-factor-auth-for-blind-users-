import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run } from "../src/db/index.js";
import { issueRecoveryCodeSet, verifyAndConsumeRecoveryCode } from "../src/services/recoveryCodes.js";

function makeUser(): string {
  const id = randomUUID();
  run("INSERT INTO users (id, display_name, email, status) VALUES (?, ?, ?, 'ACTIVE')", [id, "Test User", `${id}@example.test`]);
  return id;
}

test("issues 8 distinct recovery codes", async () => {
  const userId = makeUser();
  const codes = await issueRecoveryCodeSet(userId);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
});

test("redeeming one code invalidates the entire set", async () => {
  const userId = makeUser();
  const codes = await issueRecoveryCodeSet(userId);

  const first = await verifyAndConsumeRecoveryCode(userId, codes[0]);
  assert.equal(first, "ok");

  const second = await verifyAndConsumeRecoveryCode(userId, codes[1]);
  assert.equal(second, "already_used");
});

test("an unrecognised code is rejected", async () => {
  const userId = makeUser();
  await issueRecoveryCodeSet(userId);
  const result = await verifyAndConsumeRecoveryCode(userId, "bogus-code-that-was-never-issued-ok");
  assert.equal(result, "no_match");
});

test("reissuing a set invalidates the previous one", async () => {
  const userId = makeUser();
  const firstSet = await issueRecoveryCodeSet(userId);
  await issueRecoveryCodeSet(userId); // reissue

  const result = await verifyAndConsumeRecoveryCode(userId, firstSet[0]);
  assert.equal(result, "no_match");
});

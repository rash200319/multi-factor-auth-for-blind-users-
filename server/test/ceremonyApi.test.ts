import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run } from "../src/db/index.js";
import {
  getUser,
  advanceAfterRegistration,
  expectedDeviceForStatus,
  confirmFirstStepUpCode,
  recordStepUpFailure,
  isLocked,
} from "../src/services/ceremonyApi.js";

function makeUser(): string {
  const id = randomUUID();
  run("INSERT INTO users (id, display_name, status) VALUES (?, ?, 'PENDING_LAPTOP')", [id, "Test User"]);
  return id;
}

test("account walks laptop -> phone -> key -> code-confirm -> active in order", () => {
  const userId = makeUser();
  assert.equal(expectedDeviceForStatus(getUser(userId)!.status), "laptop");

  advanceAfterRegistration(userId, "laptop");
  assert.equal(getUser(userId)!.status, "PENDING_PHONE");
  assert.equal(expectedDeviceForStatus(getUser(userId)!.status), "phone");

  advanceAfterRegistration(userId, "phone");
  assert.equal(getUser(userId)!.status, "PENDING_KEY");

  advanceAfterRegistration(userId, "security_key");
  assert.equal(getUser(userId)!.status, "PENDING_CODE_CONFIRM");
  assert.equal(expectedDeviceForStatus(getUser(userId)!.status), null);

  confirmFirstStepUpCode(userId);
  assert.equal(getUser(userId)!.status, "ACTIVE");
});

test("account is not usable (no ACTIVE status) until all three devices + code are done", () => {
  const userId = makeUser();
  advanceAfterRegistration(userId, "laptop");
  assert.notEqual(getUser(userId)!.status, "ACTIVE");
});

test("5 consecutive step-up failures locks the account", () => {
  const userId = makeUser();
  run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [userId]);

  let locked = false;
  for (let i = 0; i < 5; i++) {
    locked = recordStepUpFailure(userId);
  }
  assert.equal(locked, true);
  assert.equal(isLocked(getUser(userId)!), true);
});

test("fewer than 5 failures does not lock the account", () => {
  const userId = makeUser();
  run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [userId]);

  for (let i = 0; i < 4; i++) {
    recordStepUpFailure(userId);
  }
  assert.equal(isLocked(getUser(userId)!), false);
});

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
  devSkipSecurityKey,
} from "../src/services/ceremonyApi.js";
import { setNotificationChannelForTesting, type NotificationChannel } from "../src/services/notify.js";

function makeUser(): string {
  const id = randomUUID();
  run("INSERT INTO users (id, display_name, email, status) VALUES (?, ?, ?, 'PENDING_LAPTOP')", [id, "Test User", `${id}@example.test`]);
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

test("5 consecutive step-up failures locks the account", async () => {
  const userId = makeUser();
  run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [userId]);

  let locked = false;
  for (let i = 0; i < 5; i++) {
    locked = await recordStepUpFailure(userId);
  }
  assert.equal(locked, true);
  assert.equal(isLocked(getUser(userId)!), true);
});

test("fewer than 5 failures does not lock the account", async () => {
  const userId = makeUser();
  run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [userId]);

  for (let i = 0; i < 4; i++) {
    await recordStepUpFailure(userId);
  }
  assert.equal(isLocked(getUser(userId)!), false);
});

test("the 5th failure sends exactly one lockout notification; earlier failures send none", async () => {
  const userId = makeUser();
  run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [userId]);

  const sent: { to: string; subject: string }[] = [];
  const fake: NotificationChannel = {
    async send(to, subject) {
      sent.push({ to, subject });
    },
  };
  setNotificationChannelForTesting(fake);

  for (let i = 0; i < 4; i++) await recordStepUpFailure(userId);
  assert.equal(sent.length, 0);

  await recordStepUpFailure(userId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, `${userId}@example.test`);
  assert.match(sent[0].subject, /locked/i);
});

test("devSkipSecurityKey advances PENDING_KEY straight to PENDING_CODE_CONFIRM", () => {
  const userId = makeUser();
  advanceAfterRegistration(userId, "laptop");
  advanceAfterRegistration(userId, "phone");
  assert.equal(getUser(userId)!.status, "PENDING_KEY");

  devSkipSecurityKey(userId);
  assert.equal(getUser(userId)!.status, "PENDING_CODE_CONFIRM");
});

test("devSkipSecurityKey is a no-op outside PENDING_KEY", () => {
  const userId = makeUser(); // starts at PENDING_LAPTOP
  devSkipSecurityKey(userId);
  assert.equal(getUser(userId)!.status, "PENDING_LAPTOP");
});

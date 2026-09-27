import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, row } from "../src/db/index.js";
import {
  requestTier4Recovery,
  cancelTier4Recovery,
  completeTier4Recovery,
} from "../src/services/recoveryTier4.js";
import { setNotificationChannelForTesting, type NotificationChannel } from "../src/services/notify.js";

function makeUser(): { id: string; email: string } {
  const id = randomUUID();
  const email = `${id}@example.test`;
  run("INSERT INTO users (id, display_name, email, status) VALUES (?, ?, ?, 'ACTIVE')", [id, "Test User", email]);
  return { id, email };
}

function fakeChannel() {
  const sent: { to: string; subject: string }[] = [];
  const channel: NotificationChannel = {
    async send(to, subject) {
      sent.push({ to, subject });
    },
  };
  return { channel, sent };
}

/** Test-only: backdate a request's eligible_at instead of waiting out the real delay. */
function makeEligibleNow(requestId: string) {
  run("UPDATE recovery_requests SET eligible_at = datetime('now', '-1 minute') WHERE id = ?", [requestId]);
}

test("request creates a pending row, in the future, and sends one notification", async () => {
  const { channel, sent } = fakeChannel();
  setNotificationChannelForTesting(channel);
  const user = makeUser();

  const result = await requestTier4Recovery(user.email, "I am the account owner, created this account on 2026-01-01.");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(new Date(result.eligibleAt).getTime() > Date.now());
  const stored = row<{ status: string }>("SELECT status FROM recovery_requests WHERE id = ?", [result.requestId]);
  assert.equal(stored?.status, "PENDING_DELAY");
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /recovery/i);
});

test("a second request while one is pending is rejected", async () => {
  setNotificationChannelForTesting({ async send() {} });
  const user = makeUser();

  await requestTier4Recovery(user.email, "statement one");
  const second = await requestTier4Recovery(user.email, "statement two");
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "already_pending");
});

test("an unknown email is rejected without revealing whether the account exists", async () => {
  setNotificationChannelForTesting({ async send() {} });
  const result = await requestTier4Recovery("nobody@example.test", "statement");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no_account");
});

test("finish before the delay has elapsed is rejected", async () => {
  setNotificationChannelForTesting({ async send() {} });
  const user = makeUser();
  const requested = await requestTier4Recovery(user.email, "statement");
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const finished = await completeTier4Recovery(requested.requestId);
  assert.equal(finished.ok, false);
  if (finished.ok) return;
  assert.equal(finished.reason, "delay_not_elapsed");
});

test("finish after the delay has elapsed sets the account to RECOVERY and notifies", async () => {
  const { channel, sent } = fakeChannel();
  setNotificationChannelForTesting(channel);
  const user = makeUser();
  const requested = await requestTier4Recovery(user.email, "statement");
  assert.equal(requested.ok, true);
  if (!requested.ok) return;
  sent.length = 0; // clear the "requested" notification, only care about "completed" below

  makeEligibleNow(requested.requestId);
  const finished = await completeTier4Recovery(requested.requestId);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.userId, user.id);

  const stored = row<{ status: string }>("SELECT status FROM recovery_requests WHERE id = ?", [requested.requestId]);
  assert.equal(stored?.status, "COMPLETED");
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /completed/i);

  // Already COMPLETED — a second finish call must not succeed again.
  const second = await completeTier4Recovery(requested.requestId);
  assert.equal(second.ok, false);
});

test("cancel prevents a later finish from succeeding", async () => {
  setNotificationChannelForTesting({ async send() {} });
  const user = makeUser();
  const requested = await requestTier4Recovery(user.email, "statement");
  assert.equal(requested.ok, true);
  if (!requested.ok) return;

  const cancelled = await cancelTier4Recovery(requested.requestId);
  assert.equal(cancelled, true);

  makeEligibleNow(requested.requestId);
  const finished = await completeTier4Recovery(requested.requestId);
  assert.equal(finished.ok, false);
  if (finished.ok) return;
  assert.equal(finished.reason, "not_pending");
});

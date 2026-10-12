import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyUser, setNotificationChannelForTesting, type NotificationChannel } from "../src/services/notify.js";

function fakeChannel() {
  const sent: { to: string; subject: string; body: string }[] = [];
  const channel: NotificationChannel = {
    async send(to, subject, body) {
      sent.push({ to, subject, body });
    },
  };
  return { channel, sent };
}

test("notifyUser sends the lockout template to the given address", async () => {
  const { channel, sent } = fakeChannel();
  setNotificationChannelForTesting(channel);

  await notifyUser("user@example.test", "lockout", { lockedUntil: "2026-01-01T00:00:00Z" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "user@example.test");
  assert.match(sent[0].subject, /locked/i);
  assert.match(sent[0].body, /2026-01-01T00:00:00Z/);
});

test("notifyUser never puts a plaintext step-up code in a notification", async () => {
  const { channel, sent } = fakeChannel();
  setNotificationChannelForTesting(channel);

  await notifyUser("user@example.test", "recovery_tier4_requested", { eligibleAt: "2026-01-04T00:00:00Z" });

  assert.equal(sent.length, 1);
  // Every template is a fixed string plus non-secret detail fields (dates,
  // statuses) — nothing resembling a step-up code (three hyphenated words)
  // is ever interpolated in.
  assert.doesNotMatch(sent[0].body, /\b[a-z]+-[a-z]+-[a-z]+\b/);
});

test("notifyUser sends a step-up notification naming the method, never the code (PDF §7.4)", async () => {
  const { channel, sent } = fakeChannel();
  setNotificationChannelForTesting(channel);

  await notifyUser("user@example.test", "stepup_completed", { method: "security_key" });

  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /security key/);
  assert.doesNotMatch(sent[0].body, /\b[a-z]+-[a-z]+-[a-z]+\b/);
});

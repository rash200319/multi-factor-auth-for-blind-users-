import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAuthenticatorType } from "../src/services/authenticatorType.js";

test("laptop step accepts an internal (platform) authenticator", () => {
  const result = validateAuthenticatorType("laptop", ["internal"], "platform");
  assert.equal(result.ok, true);
});

test("laptop step rejects a phone paired over hybrid transport", () => {
  const result = validateAuthenticatorType("laptop", ["hybrid"], "cross-platform");
  assert.equal(result.ok, false);
});

test("laptop step rejects a physical security key", () => {
  const result = validateAuthenticatorType("laptop", ["usb"], "cross-platform");
  assert.equal(result.ok, false);
});

test("phone step accepts a hybrid (cross-device) credential", () => {
  const result = validateAuthenticatorType("phone", ["hybrid"], "cross-platform");
  assert.equal(result.ok, true);
});

test("phone step rejects reusing the laptop's platform authenticator", () => {
  const result = validateAuthenticatorType("phone", ["internal"], "platform");
  assert.equal(result.ok, false);
});

test("phone step rejects a physical security key", () => {
  const result = validateAuthenticatorType("phone", ["usb"], "cross-platform");
  assert.equal(result.ok, false);
});

test("security_key step accepts a usb/nfc physical key", () => {
  const result = validateAuthenticatorType("security_key", ["usb", "nfc"], "cross-platform");
  assert.equal(result.ok, true);
});

test("security_key step rejects a phone (hybrid)", () => {
  const result = validateAuthenticatorType("security_key", ["hybrid"], "cross-platform");
  assert.equal(result.ok, false);
});

test("security_key step rejects the laptop's platform authenticator", () => {
  const result = validateAuthenticatorType("security_key", ["internal"], "platform");
  assert.equal(result.ok, false);
});

test("replacement step accepts anything", () => {
  assert.equal(validateAuthenticatorType("replacement", ["hybrid"], undefined).ok, true);
  assert.equal(validateAuthenticatorType("replacement", ["internal"], "platform").ok, true);
  assert.equal(validateAuthenticatorType("replacement", undefined, undefined).ok, true);
});

test("no transport signal at all does not block enrolment", () => {
  const result = validateAuthenticatorType("phone", undefined, undefined);
  assert.equal(result.ok, true);
});

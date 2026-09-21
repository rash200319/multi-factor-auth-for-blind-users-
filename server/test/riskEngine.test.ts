import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk } from "../src/services/riskEngine.js";

test("routine login from a known device on a known network is low risk", () => {
  const risk = evaluateRisk({ isNewDevice: false, isNewNetworkRange: false, signCountOk: true });
  assert.equal(risk, "low");
});

test("a high-value operation always triggers step-up, even on a known device", () => {
  const risk = evaluateRisk({
    operation: "payment",
    isNewDevice: false,
    isNewNetworkRange: false,
    signCountOk: true,
  });
  assert.equal(risk, "high");
});

test("a new device triggers step-up even for a routine operation", () => {
  const risk = evaluateRisk({ isNewDevice: true, isNewNetworkRange: false, signCountOk: true });
  assert.equal(risk, "high");
});

test("a new network range triggers step-up", () => {
  const risk = evaluateRisk({ isNewDevice: false, isNewNetworkRange: true, signCountOk: true });
  assert.equal(risk, "high");
});

test("recovery_contact_change is treated as high value", () => {
  const risk = evaluateRisk({
    operation: "recovery_contact_change",
    isNewDevice: false,
    isNewNetworkRange: false,
    signCountOk: true,
  });
  assert.equal(risk, "high");
});

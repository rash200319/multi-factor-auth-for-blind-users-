import { startRegistration } from "@simplewebauthn/browser";
import { api } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const userIdInput = $<HTMLInputElement>("recovery-user-id");
const codeInput = $<HTMLInputElement>("recovery-code-input");
const redeemBtn = $<HTMLButtonElement>("redeem-btn");
const status = $("status");
const replacementPanel = $("replacement-panel");
const replacementHeading = $("replacement-heading");
const registerReplacementBtn = $<HTMLButtonElement>("register-replacement-btn");
const alertRegion = $("alert-region");

let userId: string | null = null;

moveFocusTo(document.getElementById("page-title"));

redeemBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  userId = userIdInput.value.trim();
  if (!userId || !codeInput.value.trim()) {
    renderAlert(alertRegion, "Enter both your account ID and a recovery code.", "Then select Recover account.");
    return;
  }
  try {
    const result = await api<{ result: string; nextStep?: string }>("/recovery/redeem", {
      userId,
      code: codeInput.value.trim(),
    });
    if (result.result === "ok") {
      status.hidden = false;
      status.textContent = "Recovery code accepted. Your account is temporarily active.";
      announcePolite("Recovery code accepted. Register a replacement device to restore full protection.");
      replacementPanel.hidden = false;
      moveFocusTo(replacementHeading);
    }
  } catch (err: any) {
    const reason = err?.data?.result;
    renderAlert(
      alertRegion,
      "That recovery code was not accepted.",
      reason === "already_used"
        ? "This recovery code set has already been used. Contact support for identity-proofed recovery."
        : "Check the code and your account ID, then try again."
    );
  }
});

registerReplacementBtn.addEventListener("click", async () => {
  if (!userId) return;
  alertRegion.innerHTML = "";
  try {
    const begin = await api<{ options: any; deviceLabel: string }>("/register/begin", { userId });
    announcePolite("Touch your fingerprint sensor to register your replacement device.");
    const response = await startRegistration(begin.options);
    const finish = await api<{ accountStatus: string }>("/register/finish", {
      userId,
      response,
      replacementLabel: "laptop",
    });
    if (finish.accountStatus === "ACTIVE") {
      status.textContent = "Replacement device registered. Your account is fully active again.";
      announcePolite("Replacement device registered. Your account is fully active again.");
      replacementPanel.hidden = true;
      moveFocusTo(document.getElementById("page-title"));
    }
  } catch {
    renderAlert(alertRegion, "Replacement device registration failed.", "Try again.");
  }
});

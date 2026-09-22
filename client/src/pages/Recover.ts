import { startRegistration } from "@simplewebauthn/browser";
import { api, describeAuthenticatorError } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { setupVoiceGuidanceToggle } from "../a11y/voiceGuidance.js";

setupVoiceGuidanceToggle();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const emailInput = $<HTMLInputElement>("recovery-email");
const codeInput = $<HTMLInputElement>("recovery-code-input");
const redeemBtn = $<HTMLButtonElement>("redeem-btn");
const status = $("status");
const replacementPanel = $("replacement-panel");
const replacementHeading = $("replacement-heading");
const registerReplacementBtn = $<HTMLButtonElement>("register-replacement-btn");
const alertRegion = $("alert-region");

// Internal account id, learned from the redeem response — used only to drive
// the replacement-device registration calls below, never asked of the user.
let userId: string | null = null;

moveFocusTo(document.getElementById("page-title"));

redeemBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const email = emailInput.value.trim();
  if (!email || !codeInput.value.trim()) {
    renderAlert(alertRegion, "Enter both your email and a recovery code.", "Then select Recover account.");
    return;
  }
  try {
    const result = await api<{ result: string; userId: string; nextStep?: string }>("/recovery/redeem", {
      email,
      code: codeInput.value.trim(),
    });
    if (result.result === "ok") {
      userId = result.userId;
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
        : "Check the code and your email, then try again."
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
  } catch (err) {
    renderAlert(alertRegion, "Replacement device registration failed.", describeAuthenticatorError(err));
    console.error(err);
  }
});

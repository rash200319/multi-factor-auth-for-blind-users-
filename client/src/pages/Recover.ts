import { startRegistration } from "@simplewebauthn/browser";
import { api, describeAuthenticatorError } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { setupVoiceGuidanceToggle } from "../a11y/voiceGuidance.js";
import { refreshSessionUi } from "../sessionUi.js";

setupVoiceGuidanceToggle();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const lookupEmail = $<HTMLInputElement>("lookup-email");
const lookupBtn = $<HTMLButtonElement>("lookup-btn");
const lookupResult = $("lookup-result");
const emailInput = $<HTMLInputElement>("recovery-email");
const codeInput = $<HTMLInputElement>("recovery-code-input");
const redeemBtn = $<HTMLButtonElement>("redeem-btn");
const status = $("status");
const replacementPanel = $("replacement-panel");
const replacementHeading = $("replacement-heading");
const registerReplacementBtn = $<HTMLButtonElement>("register-replacement-btn");
const sessionPanel = $("session-panel");
const alertRegion = $("alert-region");

const showTier4Btn = $<HTMLButtonElement>("show-tier4-btn");
const tier4Form = $("tier4-form");
const tier4EmailInput = $<HTMLInputElement>("tier4-email");
const tier4StatementInput = $<HTMLTextAreaElement>("tier4-statement");
const tier4SubmitBtn = $<HTMLButtonElement>("tier4-submit-btn");
const tier4Status = $("tier4-status");
const tier4FinishPanel = $("tier4-finish-panel");
const tier4RequestIdInput = $<HTMLInputElement>("tier4-request-id");
const tier4FinishBtn = $<HTMLButtonElement>("tier4-finish-btn");
const tier4FinishHint = $("tier4-finish-hint");
const tier4CancelIdInput = $<HTMLInputElement>("tier4-cancel-id");
const tier4CancelBtn = $<HTMLButtonElement>("tier4-cancel-btn");

// Internal account id, learned from the redeem response — used only to drive
// the replacement-device registration calls below, never asked of the user.
let userId: string | null = null;

moveFocusTo(document.getElementById("page-title"));
void refreshSessionUi({ panel: sessionPanel });

lookupBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const email = lookupEmail.value.trim();
  if (!email) {
    renderAlert(alertRegion, "Enter your email.", "Then select Check account.");
    return;
  }
  try {
    const lookup = await api<{
      exists: boolean;
      guidance?: string;
      status?: string;
      registeredDevices?: string[];
      canResumeEnrolment?: boolean;
    }>("/account/lookup", { email });

    emailInput.value = email;
    lookupResult.hidden = false;
    lookupResult.textContent = "";

    if (!lookup.exists) {
      lookupResult.textContent = lookup.guidance ?? "No account found.";
      announcePolite(lookupResult.textContent);
      return;
    }

    const devices = (lookup.registeredDevices ?? []).join(", ") || "none";
    lookupResult.innerHTML = `<p><strong>Status:</strong> ${lookup.status}. <strong>Devices:</strong> ${devices}.</p><p>${lookup.guidance ?? ""}</p>`;

    if (lookup.canResumeEnrolment) {
      lookupResult.innerHTML += `<p>Enrolment unfinished — <a href="/enrol.html">Resume on Create account</a> instead of recovering.</p>`;
    } else if (lookup.status === "ACTIVE") {
      lookupResult.innerHTML += `<p>If you still have a phone passkey, prefer <a href="/index.html">Sign in</a> first. Use a recovery code below only if every authenticator is gone.</p>`;
    }

    announcePolite(lookup.guidance ?? "Account found.");
  } catch (err) {
    renderAlert(alertRegion, "Lookup failed.", describeAuthenticatorError(err));
  }
});

redeemBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const email = emailInput.value.trim() || lookupEmail.value.trim();
  if (!email || !codeInput.value.trim()) {
    renderAlert(alertRegion, "Enter email and a recovery code.", "Then select Recover with this code.");
    return;
  }
  try {
    const result = await api<{ result: string; userId: string }>("/recovery/redeem", {
      email,
      code: codeInput.value.trim(),
    });
    if (result.result === "ok") {
      userId = result.userId;
      status.hidden = false;
      status.textContent = "Recovery code accepted. Register a replacement device next.";
      announcePolite("Recovery code accepted. Register a replacement device.");
      replacementPanel.hidden = false;
      await refreshSessionUi({ panel: sessionPanel });
      moveFocusTo(replacementHeading);
    }
  } catch (err: any) {
    const reason = err?.data?.result;
    renderAlert(
      alertRegion,
      "That recovery code was not accepted.",
      reason === "already_used"
        ? "This recovery set was already used. Contact support for identity-proofed recovery."
        : err?.status === 404
          ? "No account found for that email. Check spelling, or Create account."
          : "Check the code and email, then try again."
    );
  }
});

showTier4Btn.addEventListener("click", () => {
  tier4Form.hidden = false;
  showTier4Btn.hidden = true;
  moveFocusTo(tier4EmailInput);
});

tier4SubmitBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const email = tier4EmailInput.value.trim();
  const statement = tier4StatementInput.value.trim();
  if (!email || !statement) {
    renderAlert(alertRegion, "Enter both your email and a statement.", "Then select Submit recovery request.");
    return;
  }
  try {
    const result = await api<{ requestId: string; eligibleAt: string }>("/recovery/tier4/request", {
      email,
      statement,
    });
    tier4Form.hidden = true;
    tier4Status.hidden = false;
    const eligible = new Date(result.eligibleAt).toLocaleString();
    tier4Status.textContent = `Recovery request submitted. A notification has been sent to your email. This cannot complete before ${eligible}.`;
    announcePolite(`Recovery request submitted. It cannot complete before ${eligible}. Keep your request ID to complete it after that time, or to cancel it if you did not make this request.`);
    tier4RequestIdInput.value = result.requestId;
    tier4FinishHint.textContent = `Not usable until ${eligible}.`;
    tier4FinishPanel.hidden = false;
  } catch (err: any) {
    const reason = err?.data?.error;
    renderAlert(
      alertRegion,
      "Could not submit the recovery request.",
      reason === "already_pending"
        ? "A recovery request is already pending on this account."
        : reason === "no_account"
          ? "Check the email address and try again."
          : "Try again in a moment."
    );
  }
});

tier4FinishBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const requestId = tier4RequestIdInput.value.trim();
  if (!requestId) return;
  try {
    const result = await api<{ userId: string; accountStatus: string }>("/recovery/tier4/finish", { requestId });
    if (result.accountStatus === "RECOVERY") {
      userId = result.userId;
      tier4FinishPanel.hidden = true;
      status.hidden = false;
      status.textContent = "Recovery request completed. Your account is temporarily active.";
      announcePolite("Recovery request completed. Register a replacement device to restore full protection.");
      replacementPanel.hidden = false;
      moveFocusTo(replacementHeading);
    }
  } catch (err: any) {
    const reason = err?.data?.error;
    renderAlert(
      alertRegion,
      "The recovery request cannot complete yet.",
      reason === "delay_not_elapsed"
        ? "The mandatory waiting period has not passed yet. Try again after the time shown above."
        : "That request is no longer valid — it may have been cancelled or already used."
    );
  }
});

tier4CancelBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const requestId = tier4CancelIdInput.value.trim();
  if (!requestId) {
    renderAlert(alertRegion, "Enter the request ID from the notification.", "Then select Cancel this request.");
    return;
  }
  try {
    await api("/recovery/tier4/cancel", { requestId });
    announcePolite("That recovery request has been cancelled.");
    tier4CancelIdInput.value = "";
  } catch {
    renderAlert(alertRegion, "Could not cancel that request.", "Check the request ID and try again.");
  }
});

registerReplacementBtn.addEventListener("click", async () => {
  if (!userId) return;
  alertRegion.innerHTML = "";
  try {
    const begin = await api<{ options: any }>("/register/begin", { userId });
    announcePolite("Touch your fingerprint sensor to register your replacement device.");
    const response = await startRegistration(begin.options);
    const finish = await api<{ accountStatus: string }>("/register/finish", {
      userId,
      response,
      replacementLabel: "laptop",
    });
    if (finish.accountStatus === "ACTIVE") {
      status.textContent = "Replacement device registered. Your account is fully active again.";
      announcePolite("Replacement device registered. Account fully active.");
      replacementPanel.hidden = true;
      await refreshSessionUi({ panel: sessionPanel });
      moveFocusTo(document.getElementById("session-heading") ?? document.getElementById("page-title"));
    }
  } catch (err) {
    renderAlert(alertRegion, "Replacement device registration failed.", describeAuthenticatorError(err));
    console.error(err);
  }
});

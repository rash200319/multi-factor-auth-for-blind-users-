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

import { startRegistration } from "@simplewebauthn/browser";
import { api, describeAuthenticatorError } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { setupVoiceGuidanceToggle } from "../a11y/voiceGuidance.js";
import { verifyPrivateAudioRoute, speakCode } from "../audio/routeCheck.js";

setupVoiceGuidanceToggle();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const nameStep = $("name-step");
const displayNameInput = $<HTMLInputElement>("display-name");
const emailInput = $<HTMLInputElement>("email-input");
const startAccountBtn = $<HTMLButtonElement>("start-account-btn");
const status = $("status");
const progressList = $("progress-list");
const registerDeviceBtn = $<HTMLButtonElement>("register-device-btn");
const skipSecurityKeyBtn = $<HTMLButtonElement>("skip-security-key-btn");
const codeConfirmPanel = $("code-confirm-panel");
const codeConfirmHeading = $("code-confirm-heading");
const headphoneConfirmEnrol = $<HTMLInputElement>("headphone-confirm-enrol");
const speakFirstCodeBtn = $<HTMLButtonElement>("speak-first-code-btn");
const repeatCodeInput = $<HTMLInputElement>("repeat-code-input");
const confirmCaptureBtn = $<HTMLButtonElement>("confirm-capture-btn");
const recoveryPanel = $("recovery-codes-panel");
const recoveryHeading = $("recovery-codes-heading");
const recoveryList = $<HTMLUListElement>("recovery-codes-list");
const recoveryDoneBtn = $<HTMLButtonElement>("recovery-codes-done-btn");
const alertRegion = $("alert-region");

const DEVICE_STEP_LABELS: Record<string, string> = {
  laptop: "Laptop passkey",
  phone: "Phone authenticator",
  security_key: "Roaming security key",
};

const DEVICE_STEP_PROMPTS: Record<string, string> = {
  laptop: "Touch this laptop's fingerprint sensor now, or complete Windows Hello, to register it.",
  phone: "A QR code and Bluetooth prompt will appear. Scan it with your phone, then confirm with your phone's fingerprint or face unlock. Keep both devices unlocked and nearby — this can take a little while on the first try.",
  security_key: "Insert or tap your physical security key now, and touch it if it flashes.",
};

let userId: string | null = null;
let nextDeviceLabel: string | null = null;

moveFocusTo(document.getElementById("page-title"));

function setProgress(label: string, text: string) {
  const el = document.getElementById(`progress-${label === "security_key" ? "key" : label}`);
  if (el) {
    const idx = { laptop: "1", phone: "2", security_key: "3" }[label] ?? "";
    el.textContent = `${idx}. ${DEVICE_STEP_LABELS[label]} — ${text}`;
  }
}

/** The skip option only ever makes sense at the security-key step. */
function updateSkipButtonVisibility(label: string | null) {
  skipSecurityKeyBtn.hidden = label !== "security_key";
}

startAccountBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const displayName = displayNameInput.value.trim();
  const email = emailInput.value.trim();
  if (!displayName) {
    renderAlert(alertRegion, "Please enter your name.", "Then select Start enrolment again.");
    return;
  }
  if (!email) {
    renderAlert(alertRegion, "Please enter your email.", "This is what you'll use for account recovery — then select Start enrolment again.");
    return;
  }
  try {
    // userId is an internal key kept only in this page's memory for the rest
    // of enrolment — the user is never asked to remember it. Email is the
    // identifier they'll actually use later, for recovery.
    const result = await api<{ userId: string; email: string; status: string }>("/register/start-account", {
      displayName,
      email,
    });
    userId = result.userId;
    nameStep.hidden = true;
    status.hidden = false;
    status.textContent = `Account started for ${result.email}. Sign-in itself needs no password or ID — it recognises your registered device. Keep this email for account recovery.`;
    progressList.hidden = false;
    registerDeviceBtn.hidden = false;
    nextDeviceLabel = "laptop";
    updateSkipButtonVisibility(nextDeviceLabel);
    setProgress("laptop", "ready to register — select “Register this device”");
    announcePolite("Account started. Ready to register your laptop passkey.");
    moveFocusTo(registerDeviceBtn);
  } catch (err: any) {
    if (err?.status === 409) {
      renderAlert(alertRegion, "An account with that email already exists.", "Sign in instead, or use a different email.");
    } else if (err?.status === 400) {
      renderAlert(alertRegion, "Please enter a valid email address.", "Then select Start enrolment again.");
    } else {
      renderAlert(alertRegion, "Could not start enrolment.", "Try again in a moment.");
    }
  }
});

registerDeviceBtn.addEventListener("click", async () => {
  if (!userId || !nextDeviceLabel) return;
  alertRegion.innerHTML = "";
  try {
    const begin = await api<{ options: any; deviceLabel: string }>("/register/begin", { userId });
    announcePolite(DEVICE_STEP_PROMPTS[begin.deviceLabel] ?? `Registering your ${DEVICE_STEP_LABELS[begin.deviceLabel]}.`);
    const response = await startRegistration(begin.options);
    const finish = await api<{ deviceLabel: string; accountStatus: string }>("/register/finish", {
      userId,
      response,
    });

    setProgress(finish.deviceLabel, "registered");
    announcePolite(`${DEVICE_STEP_LABELS[finish.deviceLabel]} registered.`);

    if (finish.accountStatus === "PENDING_CODE_CONFIRM") {
      registerDeviceBtn.hidden = true;
      updateSkipButtonVisibility(null);
      codeConfirmPanel.hidden = false;
      moveFocusTo(codeConfirmHeading);
    } else {
      nextDeviceLabel =
        finish.accountStatus === "PENDING_PHONE" ? "phone" :
        finish.accountStatus === "PENDING_KEY" ? "security_key" : null;
      updateSkipButtonVisibility(nextDeviceLabel);
      if (nextDeviceLabel) {
        setProgress(nextDeviceLabel, "ready to register — select “Register this device”");
        moveFocusTo(registerDeviceBtn);
      }
    }
  } catch (err) {
    renderAlert(alertRegion, "Device registration was not completed.", describeAuthenticatorError(err));
    console.error(err);
  }
});

skipSecurityKeyBtn.addEventListener("click", async () => {
  if (!userId) return;
  alertRegion.innerHTML = "";
  try {
    const result = await api<{ skipped: boolean; accountStatus: string }>("/register/dev-skip-security-key", {
      userId,
    });
    const el = document.getElementById("progress-key");
    if (el) el.textContent = "3. Roaming security key — skipped (testing only, no recovery tier from this device)";
    announcePolite("Security key step skipped for testing. Moving to your first security code.");

    if (result.accountStatus === "PENDING_CODE_CONFIRM") {
      registerDeviceBtn.hidden = true;
      updateSkipButtonVisibility(null);
      codeConfirmPanel.hidden = false;
      moveFocusTo(codeConfirmHeading);
    }
  } catch (err: any) {
    if (err?.status === 404) {
      renderAlert(
        alertRegion,
        "Skipping the security key isn't enabled on this server.",
        "Set DEV_ALLOW_SKIP_SECURITY_KEY=true in server/.env and restart the server to enable it for testing."
      );
    } else {
      renderAlert(alertRegion, "Could not skip this step.", "Try again.");
    }
  }
});

speakFirstCodeBtn.addEventListener("click", async () => {
  if (!userId) return;
  alertRegion.innerHTML = "";
  const route = await verifyPrivateAudioRoute(headphoneConfirmEnrol.checked);
  if (!route.verified) {
    renderAlert(
      alertRegion,
      "We cannot speak your first security code without confirming a private audio route.",
      "Check the headphones box above and try again."
    );
    return;
  }
  try {
    const { code } = await api<{ code: string }>("/stepup/challenge", { userId, privateRouteConfirmed: true });
    announcePolite("Speaking your first security code now.");
    await speakCode(code);
    announcePolite("Code spoken. Type it back to confirm.");
    repeatCodeInput.focus();
  } catch {
    renderAlert(alertRegion, "Could not issue your first security code.", "Try again in a moment.");
  }
});

confirmCaptureBtn.addEventListener("click", async () => {
  if (!userId) return;
  alertRegion.innerHTML = "";
  try {
    const result = await api<{ captured: boolean; accountStatus?: string }>("/stepup/confirm-capture", {
      userId,
      repeatedCode: repeatCodeInput.value,
    });
    if (!result.captured) {
      renderAlert(alertRegion, "That did not match the code we spoke.", "Select “Speak my security code” to hear it again.");
      return;
    }
    setProgress("code" as any, "confirmed");
    const el = document.getElementById("progress-code");
    if (el) el.textContent = "4. Confirm your spoken security code — confirmed";
    announcePolite("Security code confirmed. Your account is now active. Issuing your written recovery codes.");
    codeConfirmPanel.hidden = true;

    const recovery = await api<{ codes: string[] }>("/recovery/codes/issue", { userId });
    recoveryList.innerHTML = "";
    for (const code of recovery.codes) {
      const li = document.createElement("li");
      li.textContent = code;
      recoveryList.appendChild(li);
    }
    recoveryPanel.hidden = false;
    moveFocusTo(recoveryHeading);
  } catch {
    renderAlert(alertRegion, "Could not confirm the code.", "Try again.");
  }
});

recoveryDoneBtn.addEventListener("click", () => {
  recoveryPanel.hidden = true;
  status.textContent = "Enrolment complete. Your account is active.";
  announcePolite("Enrolment complete. You can now sign in.");
  moveFocusTo(document.getElementById("page-title"));
});

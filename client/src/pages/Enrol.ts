import { startRegistration } from "@simplewebauthn/browser";
import { api } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { verifyPrivateAudioRoute, speakCode } from "../audio/routeCheck.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const nameStep = $("name-step");
const displayNameInput = $<HTMLInputElement>("display-name");
const startAccountBtn = $<HTMLButtonElement>("start-account-btn");
const status = $("status");
const progressList = $("progress-list");
const registerDeviceBtn = $<HTMLButtonElement>("register-device-btn");
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

startAccountBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const displayName = displayNameInput.value.trim();
  if (!displayName) {
    renderAlert(alertRegion, "Please enter your name.", "Then select Start enrolment again.");
    return;
  }
  try {
    const result = await api<{ userId: string; status: string }>("/register/start-account", { displayName });
    userId = result.userId;
    nameStep.hidden = true;
    status.hidden = false;
    status.textContent = `Account started. Your account ID is ${userId}. Save this somewhere — you will need it to sign in from a new browser and for account recovery.`;
    progressList.hidden = false;
    registerDeviceBtn.hidden = false;
    nextDeviceLabel = "laptop";
    setProgress("laptop", "ready to register — select “Register this device”");
    announcePolite("Account started. Ready to register your laptop passkey.");
    moveFocusTo(registerDeviceBtn);
  } catch {
    renderAlert(alertRegion, "Could not start enrolment.", "Try again in a moment.");
  }
});

registerDeviceBtn.addEventListener("click", async () => {
  if (!userId || !nextDeviceLabel) return;
  alertRegion.innerHTML = "";
  try {
    const begin = await api<{ options: any; deviceLabel: string }>("/register/begin", { userId });
    announcePolite(`Touch your fingerprint sensor to register your ${DEVICE_STEP_LABELS[begin.deviceLabel]}.`);
    const response = await startRegistration(begin.options);
    const finish = await api<{ deviceLabel: string; accountStatus: string }>("/register/finish", {
      userId,
      response,
    });

    setProgress(finish.deviceLabel, "registered");
    announcePolite(`${DEVICE_STEP_LABELS[finish.deviceLabel]} registered.`);

    if (finish.accountStatus === "PENDING_CODE_CONFIRM") {
      registerDeviceBtn.hidden = true;
      codeConfirmPanel.hidden = false;
      moveFocusTo(codeConfirmHeading);
    } else {
      nextDeviceLabel =
        finish.accountStatus === "PENDING_PHONE" ? "phone" :
        finish.accountStatus === "PENDING_KEY" ? "security_key" : null;
      if (nextDeviceLabel) {
        setProgress(nextDeviceLabel, "ready to register — select “Register this device”");
        moveFocusTo(registerDeviceBtn);
      }
    }
  } catch (err) {
    renderAlert(alertRegion, "Device registration was not completed.", "Try again — make sure you complete the fingerprint prompt.");
    console.error(err);
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

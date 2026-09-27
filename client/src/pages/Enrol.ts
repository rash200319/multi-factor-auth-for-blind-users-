import { startRegistration } from "@simplewebauthn/browser";
import { api, describeAuthenticatorError } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { setupVoiceGuidanceToggle } from "../a11y/voiceGuidance.js";
import { verifyPrivateAudioRoute, speakCode } from "../audio/routeCheck.js";
import { refreshSessionUi } from "../sessionUi.js";

setupVoiceGuidanceToggle();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = "mfa_enrol_userId";
const STORAGE_EMAIL = "mfa_enrol_email";

const startPanel = $("start-panel");
const nameStep = $("name-step");
const displayNameInput = $<HTMLInputElement>("display-name");
const emailInput = $<HTMLInputElement>("email-input");
const startAccountBtn = $<HTMLButtonElement>("start-account-btn");
const resumeBtn = $<HTMLButtonElement>("resume-btn");
const status = $("status");
const progressList = $("progress-list");
const registerDeviceBtn = $<HTMLButtonElement>("register-device-btn");
const skipSecurityKeyBtn = $<HTMLButtonElement>("skip-security-key-btn");
const phoneHelp = $("phone-help");
const laptopHelp = $("laptop-help");
const keyHelp = $("key-help");
const sessionPanel = $("session-panel");
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
const enrolDoneHint = $("enrol-done-hint");
const alertRegion = $("alert-region");

const DEVICE_STEP_LABELS: Record<string, string> = {
  laptop: "Laptop passkey",
  phone: "Phone authenticator",
  security_key: "Roaming security key",
};

const DEVICE_STEP_PROMPTS: Record<string, string> = {
  laptop: "Touch this laptop's fingerprint sensor now, or complete Windows Hello.",
  phone: "Use More options → phone or Android if you see a USB key dialog, then scan the QR.",
  security_key: "Insert or tap your physical security key now.",
};

let userId: string | null = localStorage.getItem(STORAGE_KEY);
let nextDeviceLabel: string | null = null;

moveFocusTo(document.getElementById("page-title"));
void refreshSessionUi({ panel: sessionPanel });

function setStepState(label: "laptop" | "phone" | "key" | "code", state: "todo" | "current" | "done", text: string) {
  const el = document.getElementById(`progress-${label}`);
  if (!el) return;
  const titles = {
    laptop: "1. Laptop passkey",
    phone: "2. Phone authenticator",
    key: "3. Roaming security key",
    code: "4. Confirm spoken security code",
  };
  el.classList.toggle("current", state === "current");
  el.classList.toggle("done", state === "done");
  el.textContent = `${titles[label]} — ${text}`;
}

function applyStatus(statusValue: string, registered: string[] = []) {
  const has = (d: string) => registered.includes(d);
  setStepState("laptop", has("laptop") ? "done" : statusValue === "PENDING_LAPTOP" ? "current" : "todo", has("laptop") ? "registered" : statusValue === "PENDING_LAPTOP" ? "do this next" : "waiting");
  setStepState("phone", has("phone") ? "done" : statusValue === "PENDING_PHONE" ? "current" : "todo", has("phone") ? "registered" : statusValue === "PENDING_PHONE" ? "do this next" : "waiting");
  setStepState("key", has("security_key") ? "done" : statusValue === "PENDING_KEY" ? "current" : "todo", has("security_key") ? "registered" : statusValue === "PENDING_KEY" ? "do this next" : "waiting");
  setStepState(
    "code",
    statusValue === "PENDING_CODE_CONFIRM" ? "current" : statusValue === "ACTIVE" ? "done" : "todo",
    statusValue === "PENDING_CODE_CONFIRM" ? "do this next" : statusValue === "ACTIVE" ? "confirmed" : "waiting"
  );

  if (statusValue === "PENDING_LAPTOP") nextDeviceLabel = "laptop";
  else if (statusValue === "PENDING_PHONE") nextDeviceLabel = "phone";
  else if (statusValue === "PENDING_KEY") nextDeviceLabel = "security_key";
  else nextDeviceLabel = null;

  updateHelps(nextDeviceLabel);
  skipSecurityKeyBtn.hidden = nextDeviceLabel !== "security_key";

  if (statusValue === "PENDING_CODE_CONFIRM") {
    registerDeviceBtn.hidden = true;
    codeConfirmPanel.hidden = false;
  } else if (nextDeviceLabel) {
    registerDeviceBtn.hidden = false;
    codeConfirmPanel.hidden = true;
    registerDeviceBtn.textContent =
      nextDeviceLabel === "phone"
        ? "Register phone (QR / hybrid)"
        : nextDeviceLabel === "security_key"
          ? "Register security key"
          : "Register this laptop";
  } else {
    registerDeviceBtn.hidden = true;
  }
}

function updateHelps(label: string | null) {
  laptopHelp.hidden = label !== "laptop";
  phoneHelp.hidden = label !== "phone";
  keyHelp.hidden = label !== "security_key";
}

function enterEnrolUi(opts: {
  id: string;
  email: string;
  status: string;
  registeredDevices?: string[];
  message: string;
}) {
  userId = opts.id;
  localStorage.setItem(STORAGE_KEY, opts.id);
  localStorage.setItem(STORAGE_EMAIL, opts.email);
  startPanel.hidden = true;
  status.hidden = false;
  status.textContent = opts.message;
  progressList.hidden = false;
  applyStatus(opts.status, opts.registeredDevices ?? []);
  if (opts.status === "PENDING_CODE_CONFIRM") {
    moveFocusTo(codeConfirmHeading);
  } else {
    moveFocusTo(registerDeviceBtn);
  }
}

/** Auto-resume if this browser already started enrolment. */
async function tryAutoResume() {
  const savedEmail = localStorage.getItem(STORAGE_EMAIL);
  if (!savedEmail || !userId) return;
  emailInput.value = savedEmail;
  try {
    const lookup = await api<{
      exists: boolean;
      canResumeEnrolment?: boolean;
      userId?: string;
      status?: string;
      registeredDevices?: string[];
      email?: string;
      guidance?: string;
    }>("/account/lookup", { email: savedEmail });
    if (lookup.exists && lookup.canResumeEnrolment && lookup.userId) {
      enterEnrolUi({
        id: lookup.userId,
        email: lookup.email ?? savedEmail,
        status: lookup.status!,
        registeredDevices: lookup.registeredDevices,
        message: `Resumed enrolment for ${lookup.email}. ${lookup.guidance}`,
      });
      announcePolite("Resumed your unfinished enrolment.");
    }
  } catch {
    /* ignore */
  }
}

void tryAutoResume();

startAccountBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const displayName = displayNameInput.value.trim();
  const email = emailInput.value.trim();
  if (!displayName) {
    renderAlert(alertRegion, "Please enter your name.", "Then select Start new enrolment.");
    return;
  }
  if (!email) {
    renderAlert(alertRegion, "Please enter your email.", "Then select Start new enrolment.");
    return;
  }
  try {
    const result = await api<{ userId: string; email: string; status: string }>("/register/start-account", {
      displayName,
      email,
    });
    enterEnrolUi({
      id: result.userId,
      email: result.email,
      status: result.status,
      message: `Account started for ${result.email}. Next: register this laptop.`,
    });
    announcePolite("Account started. Register your laptop passkey next.");
  } catch (err: any) {
    if (err?.status === 409 && err?.data?.canResume && err?.data?.userId) {
      renderAlert(
        alertRegion,
        "Enrolment already started for this email.",
        "Select Resume unfinished enrolment to continue where you left off."
      );
      emailInput.value = email;
    } else if (err?.status === 409) {
      renderAlert(
        alertRegion,
        "An account with that email already exists.",
        err.data?.message ?? "Sign in instead, or use Recover account if you lost your devices."
      );
    } else {
      renderAlert(alertRegion, "Could not start enrolment.", describeAuthenticatorError(err));
    }
  }
});

resumeBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  const email = emailInput.value.trim();
  if (!email) {
    renderAlert(alertRegion, "Enter the email you used when you started enrolment.", "Then select Resume unfinished enrolment.");
    return;
  }
  try {
    const lookup = await api<{
      exists: boolean;
      canResumeEnrolment?: boolean;
      userId?: string;
      status?: string;
      registeredDevices?: string[];
      email?: string;
      guidance?: string;
    }>("/account/lookup", { email });

    if (!lookup.exists) {
      renderAlert(alertRegion, "No account found for that email.", "Start a new enrolment, or check the spelling.");
      return;
    }
    if (!lookup.canResumeEnrolment || !lookup.userId) {
      renderAlert(
        alertRegion,
        "This account has already finished enrolment.",
        lookup.guidance ?? "Use Sign in, or Recover account if you lost your devices."
      );
      return;
    }
    enterEnrolUi({
      id: lookup.userId,
      email: lookup.email ?? email,
      status: lookup.status!,
      registeredDevices: lookup.registeredDevices,
      message: lookup.guidance ?? `Resuming enrolment (${lookup.status}).`,
    });
    announcePolite("Resumed unfinished enrolment.");
  } catch (err) {
    renderAlert(alertRegion, "Could not look up that email.", describeAuthenticatorError(err));
  }
});

registerDeviceBtn.addEventListener("click", async () => {
  if (!userId || !nextDeviceLabel) return;
  alertRegion.innerHTML = "";
  try {
    const begin = await api<{ options: any; deviceLabel: string }>("/register/begin", { userId });
    announcePolite(DEVICE_STEP_PROMPTS[begin.deviceLabel] ?? `Registering ${DEVICE_STEP_LABELS[begin.deviceLabel]}.`);
    if (begin.deviceLabel === "phone") {
      phoneHelp.hidden = false;
      moveFocusTo(document.getElementById("phone-help-heading"));
    }
    const response = await startRegistration(begin.options);
    const finish = await api<{ deviceLabel: string; accountStatus: string }>("/register/finish", {
      userId,
      response,
    });

    announcePolite(`${DEVICE_STEP_LABELS[finish.deviceLabel]} registered.`);

    const email = localStorage.getItem(STORAGE_EMAIL) ?? emailInput.value.trim();
    const lookup = await api<{ registeredDevices?: string[]; status?: string; guidance?: string }>("/account/lookup", { email });
    applyStatus(finish.accountStatus, lookup.registeredDevices ?? []);
    status.textContent = `${DEVICE_STEP_LABELS[finish.deviceLabel]} registered. ${lookup.guidance ?? ""}`;

    if (finish.accountStatus === "PENDING_CODE_CONFIRM") {
      moveFocusTo(codeConfirmHeading);
    } else {
      moveFocusTo(registerDeviceBtn);
    }
  } catch (err: any) {
    const detail = describeAuthenticatorError(err);
    if (nextDeviceLabel === "phone") {
      renderAlert(
        alertRegion,
        "Phone registration was not completed.",
        `${detail} Reminder: More options → phone/Android for the QR. Or use the HTTPS tunnel in tools/README.md.`
      );
    } else {
      renderAlert(alertRegion, "Device registration was not completed.", detail);
    }
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
    applyStatus(result.accountStatus, ["laptop", "phone"]);
    status.textContent = "Security key skipped for testing. Confirm your spoken security code next.";
    announcePolite("Security key skipped. Confirm your spoken security code next.");
    moveFocusTo(codeConfirmHeading);
  } catch (err: any) {
    if (err?.status === 404) {
      renderAlert(
        alertRegion,
        "Skipping the security key isn't enabled.",
        "Set DEV_ALLOW_SKIP_SECURITY_KEY=true in server/.env and restart the server."
      );
    } else {
      renderAlert(alertRegion, "Could not skip this step.", describeAuthenticatorError(err));
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
      "Headphones not confirmed.",
      "Check the headphones box, then speak the code again."
    );
    return;
  }
  try {
    const { code } = await api<{ code: string }>("/stepup/challenge", { userId, privateRouteConfirmed: true });
    announcePolite("Speaking your first security code now.");
    await speakCode(code);
    announcePolite("Code spoken. Type the six digits back to confirm.");
    repeatCodeInput.focus();
  } catch (err) {
    renderAlert(alertRegion, "Could not issue your security code.", describeAuthenticatorError(err));
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
      renderAlert(alertRegion, "That code did not match.", "Speak the code again, then retype it.");
      return;
    }
    setStepState("code", "done", "confirmed");
    announcePolite("Security code confirmed. Saving recovery codes.");
    codeConfirmPanel.hidden = true;
    await refreshSessionUi({ panel: sessionPanel });

    const recovery = await api<{ codes: string[] }>("/recovery/codes/issue", { userId });
    recoveryList.innerHTML = "";
    for (const code of recovery.codes) {
      const li = document.createElement("li");
      li.textContent = code;
      recoveryList.appendChild(li);
    }
    recoveryPanel.hidden = false;
    localStorage.removeItem(STORAGE_KEY);
    moveFocusTo(recoveryHeading);
  } catch (err) {
    renderAlert(alertRegion, "Could not confirm the code.", describeAuthenticatorError(err));
  }
});

recoveryDoneBtn.addEventListener("click", async () => {
  enrolDoneHint.hidden = false;
  status.hidden = false;
  status.textContent = "Enrolment complete. You are signed in.";
  announcePolite("Enrolment complete. You are signed in.");
  await refreshSessionUi({ panel: sessionPanel });
  moveFocusTo(document.getElementById("session-heading") ?? document.getElementById("page-title"));
});

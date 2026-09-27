import { startAuthentication } from "@simplewebauthn/browser";
import { api, describeAuthenticatorError } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { setupVoiceGuidanceToggle } from "../a11y/voiceGuidance.js";
import { verifyPrivateAudioRoute, speakCode } from "../audio/routeCheck.js";
import { refreshSessionUi } from "../sessionUi.js";

setupVoiceGuidanceToggle();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const signinBtn = $<HTMLButtonElement>("signin-btn");
const signinControls = $("signin-controls");
const sessionPanel = $("session-panel");
const stepupPanel = $("stepup-panel");
const stepupHeading = $("stepup-heading");
const headphoneConfirm = $<HTMLInputElement>("headphone-confirm");
const speakCodeBtn = $<HTMLButtonElement>("speak-code-btn");
const codeInput = $<HTMLInputElement>("code-input");
const verifyCodeBtn = $<HTMLButtonElement>("verify-code-btn");
const useKeyInsteadBtn = $<HTMLButtonElement>("use-key-instead-btn");
const lookupEmail = $<HTMLInputElement>("lookup-email");
const lookupBtn = $<HTMLButtonElement>("lookup-btn");
const lookupResult = $("lookup-result");
const alertRegion = $("alert-region");

let pendingUserId: string | null = null;
let awaitingNextCodeConfirm = false;

moveFocusTo(document.getElementById("page-title"));

async function showSignedIn(opts?: { keepStepUp?: boolean }) {
  const me = await refreshSessionUi({
    panel: sessionPanel,
    signInControls: signinControls,
    onSignedOut: () => {
      pendingUserId = null;
      awaitingNextCodeConfirm = false;
      stepupPanel.hidden = true;
      status.textContent = "Ready to sign in.";
    },
  });
  if (me.authenticated && !opts?.keepStepUp) {
    stepupPanel.hidden = true;
  }
  return me;
}

void showSignedIn().then((me) => {
  if (me.authenticated) {
    status.textContent = `Already signed in as ${me.displayName}.`;
  }
});

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

    lookupResult.hidden = false;
    if (!lookup.exists) {
      lookupResult.textContent = lookup.guidance ?? "No account found.";
      announcePolite(lookupResult.textContent);
      return;
    }

    const devices = (lookup.registeredDevices ?? []).join(", ") || "none yet";
    lookupResult.innerHTML = "";
    const p1 = document.createElement("p");
    p1.innerHTML = `<strong>Status:</strong> ${lookup.status}. <strong>Registered:</strong> ${devices}.`;
    const p2 = document.createElement("p");
    p2.textContent = lookup.guidance ?? "";
    lookupResult.append(p1, p2);

    if (lookup.canResumeEnrolment) {
      const a = document.createElement("p");
      a.innerHTML = `<a href="/enrol.html">Open Create account</a> and use Resume unfinished enrolment.`;
      lookupResult.appendChild(a);
    } else if (lookup.status === "ACTIVE") {
      const a = document.createElement("p");
      a.innerHTML = `Still have a phone or laptop passkey? Use <strong>Sign in with fingerprint / passkey</strong> above. Otherwise go to <a href="/recover.html">Recover account</a>.`;
      lookupResult.appendChild(a);
    }

    announcePolite(lookup.guidance ?? "Account found.");
  } catch (err) {
    renderAlert(alertRegion, "Could not look up that email.", describeAuthenticatorError(err));
  }
});

signinBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  status.textContent = "Starting sign-in…";
  try {
    const { attemptId, options } = await api<{ attemptId: string; options: any }>("/auth/begin");
    announcePolite("Touch your fingerprint sensor now, or choose your phone passkey if this is a new laptop.");
    const response = await startAuthentication(options);
    const result = await api<{
      result: string;
      userId?: string;
      displayName?: string;
    }>("/auth/finish", { attemptId, response });

    if (result.result === "session_established") {
      pendingUserId = result.userId ?? null;
      status.textContent = "Signed in.";
      announcePolite("Signed in successfully.");
      await showSignedIn();
      moveFocusTo(document.getElementById("session-heading"));
    } else if (result.result === "step_up_required") {
      pendingUserId = result.userId!;
      status.textContent = "Signed in. Additional verification is required.";
      await showSignedIn({ keepStepUp: true });
      stepupPanel.hidden = false;
      announcePolite("Signed in. Additional verification is required.");
      moveFocusTo(stepupHeading);
    }
  } catch (err: any) {
    status.textContent = "Sign-in failed.";
    const detail = describeAuthenticatorError(err);
    if (err?.data?.error === "account_not_ready" || err?.status === 403) {
      renderAlert(alertRegion, "Account is not ready to sign in.", err.data?.message ?? detail);
    } else if (err?.data?.error === "unknown_credential") {
      renderAlert(alertRegion, "No matching passkey found.", err.data?.message ?? detail);
    } else if (err?.name === "NotAllowedError") {
      renderAlert(
        alertRegion,
        "No passkey was used.",
        `${detail} Tip: use Check account with your email above, or Create account if you never finished enrolment.`
      );
    } else {
      renderAlert(alertRegion, "Sign-in was not completed.", detail);
    }
    console.error(err);
  }
});

speakCodeBtn.addEventListener("click", async () => {
  if (!pendingUserId) return;
  alertRegion.innerHTML = "";
  const route = await verifyPrivateAudioRoute(headphoneConfirm.checked);
  if (!route.verified) {
    renderAlert(
      alertRegion,
      "Headphones not confirmed.",
      "Check the box, or use your security key instead."
    );
    return;
  }
  try {
    const { code } = await api<{ code: string }>("/stepup/challenge", {
      userId: pendingUserId,
      privateRouteConfirmed: true,
    });
    announcePolite("Speaking your security code now.");
    await speakCode(code);
    announcePolite("Code spoken. Enter the six digits below.");
    codeInput.focus();
  } catch (err: any) {
    if (err?.status === 409) {
      renderAlert(alertRegion, "Private audio not confirmed.", "Use your security key instead.");
    } else {
      renderAlert(alertRegion, "Could not issue a security code.", "Try again in a moment.");
    }
  }
});

verifyCodeBtn.addEventListener("click", async () => {
  if (!pendingUserId) return;
  alertRegion.innerHTML = "";
  try {
    if (!awaitingNextCodeConfirm) {
      const result = await api<{ result: string; nextCode?: string | null; locked?: boolean }>(
        "/stepup/verify",
        { userId: pendingUserId, code: codeInput.value, privateRouteConfirmed: headphoneConfirm.checked }
      );
      if (result.result === "ok") {
        status.textContent = "Verified. You are fully signed in.";
        announcePolite("Security code verified. You are fully signed in.");
        codeInput.value = "";
        await showSignedIn();
        if (result.nextCode) {
          awaitingNextCodeConfirm = true;
          stepupPanel.hidden = false;
          announcePolite("Speaking your next security code for next time.");
          await speakCode(result.nextCode);
          announcePolite("Enter the new code to confirm you heard it.");
          verifyCodeBtn.textContent = "Confirm next code";
          codeInput.focus();
        } else {
          moveFocusTo(document.getElementById("session-heading"));
        }
      } else {
        renderAlert(
          alertRegion,
          "That code was not recognised.",
          result.locked
            ? "Too many attempts — account locked. Use Recover account if needed."
            : "Try again, or use your security key instead."
        );
      }
    } else {
      const result = await api<{ captured: boolean }>("/stepup/confirm-capture", {
        userId: pendingUserId,
        repeatedCode: codeInput.value,
      });
      awaitingNextCodeConfirm = false;
      verifyCodeBtn.textContent = "Verify code";
      codeInput.value = "";
      if (result.captured) {
        announcePolite("Next code confirmed.");
        await showSignedIn();
        moveFocusTo(document.getElementById("session-heading"));
      } else {
        renderAlert(alertRegion, "That did not match.", "Speak the code again.");
      }
    }
  } catch (err) {
    renderAlert(alertRegion, "Verification failed.", describeAuthenticatorError(err));
  }
});

useKeyInsteadBtn.addEventListener("click", async () => {
  if (!pendingUserId) return;
  alertRegion.innerHTML = "";
  try {
    const { attemptId, options } = await api<{ attemptId: string; options: any }>("/stepup/key/begin", {
      userId: pendingUserId,
    });
    announcePolite("Insert and activate your registered security key now.");
    const response = await startAuthentication(options);
    const result = await api<{ result: string }>("/stepup/key/finish", { attemptId, response });
    if (result.result === "ok") {
      status.textContent = "Verified with your security key.";
      announcePolite("Security key verified. You are fully signed in.");
      await showSignedIn();
      moveFocusTo(document.getElementById("session-heading"));
    }
  } catch (err) {
    renderAlert(alertRegion, "Security key verification failed.", describeAuthenticatorError(err));
    console.error(err);
  }
});

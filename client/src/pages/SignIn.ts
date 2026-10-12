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
const speakCodeBtn = $<HTMLButtonElement>("speak-code-btn");
const codeInput = $<HTMLInputElement>("code-input");
const codeInputLabel = $("code-input-label");
const verifyCodeBtn = $<HTMLButtonElement>("verify-code-btn");
const useKeyInsteadBtn = $<HTMLButtonElement>("use-key-instead-btn");
const lookupEmail = $<HTMLInputElement>("lookup-email");
const lookupBtn = $<HTMLButtonElement>("lookup-btn");
const lookupResult = $("lookup-result");
const alertRegion = $("alert-region");

// The server never tells the client a userId for a pending step-up — it's
// carried in the mfa_stepup_ticket cookie instead (credentials: "include"
// on every request already sends it). No login session exists yet at this
// point either (docs/hardening-plan.md WI-1), so showSignedIn()/`/me` has
// nothing to report until step-up actually completes — these two booleans
// are purely local UI state, not auth state.
let stepUpPending = false;
let awaitingNextCodeConfirm = false;

moveFocusTo(document.getElementById("page-title"));

async function showSignedIn() {
  const me = await refreshSessionUi({
    panel: sessionPanel,
    signInControls: signinControls,
    onSignedOut: () => {
      stepUpPending = false;
      awaitingNextCodeConfirm = false;
      stepupPanel.hidden = true;
      status.textContent = "Ready to sign in.";
    },
  });
  if (me.authenticated) stepupPanel.hidden = true;
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
    const result = await api<{ result: string; accountStatus?: string }>("/auth/finish", {
      attemptId,
      response,
    });

    if (result.result === "session_established") {
      status.textContent = "Signed in.";
      announcePolite("Signed in successfully.");
      await showSignedIn();
      moveFocusTo(document.getElementById("session-heading"));
    } else if (result.result === "step_up_required") {
      stepUpPending = true;
      status.textContent = "Signed in with your device. Additional verification is required.";
      stepupPanel.hidden = false;
      announcePolite("Signed in with your device. Additional verification is required.");
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

/**
 * Rotation phase (PDF §6.2 step 7b.iv): the session is already elevated and
 * a fresh code must be captured for next time. Called with the code /verify
 * returned, or with one fetched via /stepup/challenge when the user asks to
 * hear a new one.
 */
async function deliverNextCode(code: string) {
  awaitingNextCodeConfirm = true;
  codeInputLabel.textContent = "Your new security code, as you just heard it";
  verifyCodeBtn.textContent = "Confirm new code";
  speakCodeBtn.hidden = false;
  announcePolite("Speaking your next security code. Memorise it — you will need it next time.");
  await speakCode(code);
  announcePolite("Enter the code you just heard to confirm you captured it.");
  codeInput.focus();
}

// The private-route declaration (PDF §13.2: a self-declared control) is the
// button press itself — each speaking button's label begins "I'm wearing
// headphones", so there is no separate checkbox to find and tick first.
const DECLARED_BY_BUTTON = true;

function refuseWithoutPrivateRoute() {
  // PDF §6.2 step 7b.i — refusal over degradation: never speak without a
  // verified private route; the security key is the remedy, so focus goes
  // straight to it rather than leaving the user to hunt for it.
  renderAlert(
    alertRegion,
    "We cannot continue with a spoken security code without a private audio route.",
    "Use your security key instead — it is selected now."
  );
  if (!useKeyInsteadBtn.hidden) useKeyInsteadBtn.focus();
}

// Only reachable once the session is elevated (after the code or the key) —
// the server refuses to speak a code to a browser that has not yet passed
// step-up, because C_n must come from the user's memory.
speakCodeBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  await verifyPrivateAudioRoute(DECLARED_BY_BUTTON);

  try {
    const { code } = await api<{ code: string }>("/stepup/challenge", {
      privateRouteConfirmed: true,
    });
    await deliverNextCode(code);
  } catch (err: any) {
    if (err?.status === 409) {
      refuseWithoutPrivateRoute();
    } else if (err?.status === 429) {
      renderAlert(alertRegion, "Too many attempts.", "Wait a few minutes before requesting another code.");
    } else {
      renderAlert(alertRegion, "Could not issue a new security code.", "Try again in a moment.");
    }
  }
});

function finishRotation() {
  awaitingNextCodeConfirm = false;
  stepUpPending = false;
  codeInputLabel.textContent = "Your current security code, from memory";
  verifyCodeBtn.textContent = "I’m wearing headphones — verify code";
  speakCodeBtn.hidden = true;
  codeInput.value = "";
}

verifyCodeBtn.addEventListener("click", async () => {
  if (!stepUpPending && !awaitingNextCodeConfirm) return;
  alertRegion.innerHTML = "";
  try {
    if (!awaitingNextCodeConfirm) {
      await verifyPrivateAudioRoute(DECLARED_BY_BUTTON);
      const result = await api<{ result: string; nextCode?: string; locked?: boolean }>(
        "/stepup/verify",
        { code: codeInput.value, privateRouteConfirmed: true }
      );
      if (result.result === "ok") {
        status.textContent = "Verified. You are fully signed in.";
        announcePolite("Security code verified. You are fully signed in.");
        codeInput.value = "";
        useKeyInsteadBtn.hidden = true;
        await showSignedIn();
        await deliverNextCode(result.nextCode!);
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
        repeatedCode: codeInput.value,
      });
      if (result.captured) {
        finishRotation();
        announcePolite("New code confirmed and saved for your next verification.");
        moveFocusTo(document.getElementById("session-heading"));
      } else {
        renderAlert(alertRegion, "That did not match the code we spoke.", "Try typing it again, or select “I’m wearing headphones — speak a new security code” to hear a different one.");
      }
    }
  } catch (err: any) {
    if (err?.status === 409) {
      refuseWithoutPrivateRoute();
    } else if (err?.status === 429) {
      renderAlert(alertRegion, "Too many attempts.", "Wait a few minutes before trying again, or use your security key instead.");
    } else if (awaitingNextCodeConfirm && err?.status === 400) {
      renderAlert(alertRegion, "That did not match the code we spoke.", "Try typing it again, or select “I’m wearing headphones — speak a new security code” to hear a different one.");
    } else if (err?.status === 400) {
      renderAlert(
        alertRegion,
        "That code was not recognised.",
        err.data?.locked ? "Too many attempts — your account is now locked. Contact support." : "Try again, or use your security key instead."
      );
    } else {
      renderAlert(alertRegion, "Verification failed.", describeAuthenticatorError(err));
    }
  }
});

useKeyInsteadBtn.addEventListener("click", async () => {
  if (!stepUpPending) return;
  alertRegion.innerHTML = "";
  try {
    const { attemptId, options } = await api<{ attemptId: string; options: any }>("/stepup/key/begin");
    announcePolite("Insert and activate your registered security key now.");
    const response = await startAuthentication(options);
    const result = await api<{ result: string }>("/stepup/key/finish", { attemptId, response });
    if (result.result === "ok") {
      status.textContent = "Verified with your security key. Session elevated.";
      announcePolite("Security key verified. You are fully signed in. If you have forgotten your spoken security code, put on headphones and select “Speak a new security code” to get a new one.");
      stepUpPending = false;
      useKeyInsteadBtn.hidden = true;
      speakCodeBtn.hidden = false;
      await showSignedIn();
      moveFocusTo(document.getElementById("session-heading"));
    }
  } catch (err) {
    renderAlert(alertRegion, "Security key verification failed.", describeAuthenticatorError(err));
    console.error(err);
  }
});

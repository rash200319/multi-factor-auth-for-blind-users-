import { startAuthentication } from "@simplewebauthn/browser";
import { api, describeAuthenticatorError } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { setupVoiceGuidanceToggle } from "../a11y/voiceGuidance.js";
import { verifyPrivateAudioRoute, speakCode } from "../audio/routeCheck.js";

setupVoiceGuidanceToggle();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const signinBtn = $<HTMLButtonElement>("signin-btn");
const stepupPanel = $("stepup-panel");
const stepupHeading = $("stepup-heading");
const speakCodeBtn = $<HTMLButtonElement>("speak-code-btn");
const codeInput = $<HTMLInputElement>("code-input");
const codeInputLabel = $("code-input-label");
const verifyCodeBtn = $<HTMLButtonElement>("verify-code-btn");
const useKeyInsteadBtn = $<HTMLButtonElement>("use-key-instead-btn");
const alertRegion = $("alert-region");

// The server no longer tells the client the userId for a pending step-up —
// it's carried in the mfa_stepup_ticket cookie instead (credentials:
// "include" on every request already sends it). This flag just gates the
// step-up UI locally. docs/hardening-plan.md WI-1.
let stepUpPending = false;
let awaitingNextCodeConfirm = false;

// SC 2.4.3 — focus moves to the page heading on load.
moveFocusTo(document.getElementById("page-title"));

signinBtn.addEventListener("click", async () => {
  alertRegion.innerHTML = "";
  status.textContent = "Starting sign-in…";
  try {
    const { attemptId, options } = await api<{ attemptId: string; options: any }>("/auth/begin");
    announcePolite("Touch your fingerprint sensor now.");
    const response = await startAuthentication(options);
    const result = await api<{ result: string; accountStatus?: string }>(
      "/auth/finish",
      { attemptId, response }
    );

    if (result.result === "session_established") {
      status.textContent = "Signed in.";
      announcePolite("Signed in successfully.");
      moveFocusTo(document.getElementById("main"));
    } else if (result.result === "step_up_required") {
      stepUpPending = true;
      status.textContent = "Signed in with your device. Additional verification is required.";
      stepupPanel.hidden = false;
      moveFocusTo(stepupHeading);
    }
  } catch (err: any) {
    renderAlert(alertRegion, "Sign-in was not completed.", describeAuthenticatorError(err));
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
    if (err?.status === 429) {
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
        status.textContent = "Verified. Session elevated.";
        announcePolite("Security code verified. You are fully signed in.");
        codeInput.value = "";
        useKeyInsteadBtn.hidden = true;
        await deliverNextCode(result.nextCode!);
      }
    } else {
      const result = await api<{ captured: boolean }>("/stepup/confirm-capture", {
        repeatedCode: codeInput.value,
      });
      if (result.captured) {
        finishRotation();
        announcePolite("New code confirmed and saved for your next verification.");
        moveFocusTo(document.getElementById("main"));
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
      renderAlert(alertRegion, "Verification failed.", "Try again, or use your security key instead.");
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
      moveFocusTo(document.getElementById("main"));
    }
  } catch (err) {
    renderAlert(alertRegion, "Security key verification failed.", describeAuthenticatorError(err));
    console.error(err);
  }
});

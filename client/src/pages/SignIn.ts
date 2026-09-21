import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "../api.js";
import { announcePolite, moveFocusTo, renderAlert } from "../a11y/announce.js";
import { verifyPrivateAudioRoute, speakCode } from "../audio/routeCheck.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const signinBtn = $<HTMLButtonElement>("signin-btn");
const stepupPanel = $("stepup-panel");
const stepupHeading = $("stepup-heading");
const headphoneConfirm = $<HTMLInputElement>("headphone-confirm");
const speakCodeBtn = $<HTMLButtonElement>("speak-code-btn");
const codeInput = $<HTMLInputElement>("code-input");
const verifyCodeBtn = $<HTMLButtonElement>("verify-code-btn");
const useKeyInsteadBtn = $<HTMLButtonElement>("use-key-instead-btn");
const alertRegion = $("alert-region");

let pendingUserId: string | null = null;
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
    const result = await api<{ result: string; userId?: string; accountStatus?: string }>(
      "/auth/finish",
      { attemptId, response }
    );

    if (result.result === "session_established") {
      status.textContent = "Signed in.";
      announcePolite("Signed in successfully.");
      moveFocusTo(document.getElementById("main"));
    } else if (result.result === "step_up_required") {
      pendingUserId = result.userId!;
      status.textContent = "Signed in with your device. Additional verification is required.";
      stepupPanel.hidden = false;
      moveFocusTo(stepupHeading);
    }
  } catch (err: any) {
    renderAlert(
      alertRegion,
      "Sign-in was not completed.",
      "Make sure this device is registered, then try again, or use account recovery."
    );
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
      "We cannot speak your security code without confirming a private audio route.",
      "Check the headphones box above, or select “Use my security key instead.”"
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
    announcePolite("Code spoken. Enter it in the box below.");
    codeInput.focus();
  } catch (err: any) {
    if (err?.status === 409) {
      renderAlert(
        alertRegion,
        "The private audio route could not be confirmed.",
        "Use your registered security key instead."
      );
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
        status.textContent = "Verified. Session elevated.";
        announcePolite("Security code verified. You are fully signed in.");
        codeInput.value = "";
        if (result.nextCode) {
          awaitingNextCodeConfirm = true;
          announcePolite("Speaking your next security code so it is ready for next time.");
          await speakCode(result.nextCode);
          announcePolite("Enter the code you just heard to confirm you captured it.");
          verifyCodeBtn.textContent = "Confirm next code";
          codeInput.focus();
        } else {
          moveFocusTo(document.getElementById("main"));
        }
      } else {
        renderAlert(
          alertRegion,
          "That code was not recognised.",
          result.locked ? "Too many attempts — your account is now locked. Contact support." : "Try again, or use your security key instead."
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
        announcePolite("Next code confirmed and saved for your next verification.");
        moveFocusTo(document.getElementById("main"));
      } else {
        renderAlert(alertRegion, "That did not match the code we spoke.", "Select “Speak my security code” again to hear it once more.");
      }
    }
  } catch (err) {
    renderAlert(alertRegion, "Verification failed.", "Try again, or use your security key instead.");
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
      status.textContent = "Verified with your security key. Session elevated.";
      announcePolite("Security key verified. You are fully signed in.");
      moveFocusTo(document.getElementById("main"));
    }
  } catch (err) {
    renderAlert(alertRegion, "Security key verification failed.", "Make sure the key is registered and try again.");
  }
});

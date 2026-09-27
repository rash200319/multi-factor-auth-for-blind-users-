import { api, apiGet } from "./api.js";
import { announcePolite, moveFocusTo } from "./a11y/announce.js";

export interface SessionInfo {
  authenticated: boolean;
  aal?: string;
  userId?: string;
  displayName?: string;
  accountStatus?: string;
}

/**
 * Renders the signed-in banner + Sign out control. Call after login,
 * step-up, enrolment confirm, and on page load.
 */
export async function refreshSessionUi(opts: {
  panel: HTMLElement;
  signInControls?: HTMLElement | null;
  onSignedOut?: () => void;
}): Promise<SessionInfo> {
  const { panel, signInControls, onSignedOut } = opts;
  try {
    const me = await apiGet<SessionInfo>("/me");
    if (!me.authenticated) {
      panel.hidden = true;
      panel.innerHTML = "";
      if (signInControls) signInControls.hidden = false;
      return me;
    }

    panel.hidden = false;
    panel.innerHTML = "";

    const heading = document.createElement("h2");
    heading.id = "session-heading";
    heading.tabIndex = -1;
    heading.textContent = `Signed in as ${me.displayName ?? "user"}`;

    const detail = document.createElement("p");
    detail.textContent =
      me.aal === "aal2-elevated"
        ? "Session elevated (step-up complete). You can perform high-value actions."
        : "Signed in with your passkey. High-value actions may still ask for a security code.";

    const logoutBtn = document.createElement("button");
    logoutBtn.type = "button";
    logoutBtn.id = "signout-btn";
    logoutBtn.textContent = "Sign out";
    logoutBtn.addEventListener("click", async () => {
      try {
        await api("/logout", {});
      } catch {
        /* still clear UI */
      }
      panel.hidden = true;
      panel.innerHTML = "";
      if (signInControls) signInControls.hidden = false;
      announcePolite("Signed out.");
      onSignedOut?.();
      moveFocusTo(document.getElementById("page-title"));
    });

    panel.append(heading, detail, logoutBtn);
    if (signInControls) signInControls.hidden = true;
    return me;
  } catch {
    panel.hidden = true;
    panel.innerHTML = "";
    if (signInControls) signInControls.hidden = false;
    return { authenticated: false };
  }
}

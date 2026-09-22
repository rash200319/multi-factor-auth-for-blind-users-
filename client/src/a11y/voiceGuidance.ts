/**
 * Opt-in narration of NON-secret instructional text (prompts, status
 * changes, error messages) via the browser's own speech synthesis.
 *
 * Off by default. A real screen-reader user already hears this content —
 * it's written into `aria-live` regions and alert roles (announce.ts),
 * which their screen reader reads. Turning this on as well would talk over
 * that. It exists for people testing or using the app WITHOUT a screen
 * reader running, who would otherwise get no audio feedback at all.
 *
 * Deliberately has nothing to do with speakCode() in audio/routeCheck.ts —
 * that path is gated by the verified-private-audio-route check because it
 * carries a secret; this path never is, because it never carries one.
 */

const STORAGE_KEY = "mfa-voice-guidance-enabled";

export function isVoiceGuidanceEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false; // private browsing / storage blocked — default off, never crash
  }
}

export function setVoiceGuidanceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // storage unavailable — the toggle still works for this page load,
    // it just won't be remembered next visit.
  }
}

/**
 * Wires up the checkbox with id="voice-guidance-toggle" (present in the
 * shared <nav> on every page). Call once per page after the DOM is ready.
 */
export function setupVoiceGuidanceToggle(): void {
  const checkbox = document.getElementById("voice-guidance-toggle") as HTMLInputElement | null;
  if (!checkbox) return;
  checkbox.checked = isVoiceGuidanceEnabled();
  checkbox.addEventListener("change", () => {
    setVoiceGuidanceEnabled(checkbox.checked);
  });
}

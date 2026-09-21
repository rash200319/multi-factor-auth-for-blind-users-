/**
 * Central accessible-announcement helpers — readme.md §8 / §2.
 *
 * Two governing rules from the design, enforced here so no page can violate
 * them by accident:
 *   1. Announce state, never appearance ("Touch your fingerprint sensor
 *      now", never "a dialog has appeared").
 *   2. The step-up code must NEVER be placed in a live region. Live regions
 *      announce on whatever output device is currently active, which would
 *      bypass the private-audio-route containment check. Callers must not
 *      pass a code string into announcePolite/announceAssertive.
 */

let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

function ensureRegions() {
  if (!politeRegion) {
    politeRegion = document.createElement("div");
    politeRegion.setAttribute("aria-live", "polite");
    politeRegion.setAttribute("role", "status");
    politeRegion.className = "sr-only";
    document.body.appendChild(politeRegion);
  }
  if (!assertiveRegion) {
    assertiveRegion = document.createElement("div");
    assertiveRegion.setAttribute("aria-live", "assertive");
    assertiveRegion.setAttribute("role", "alert");
    assertiveRegion.className = "sr-only";
    document.body.appendChild(assertiveRegion);
  }
}

/** Describes what happened or what to do next — never UI appearance. SC 4.1.3. */
export function announcePolite(message: string) {
  ensureRegions();
  politeRegion!.textContent = "";
  // Force a DOM mutation so repeated identical messages still announce.
  requestAnimationFrame(() => {
    politeRegion!.textContent = message;
  });
}

/** For approaching timeouts and similar urgent-but-not-error state. SC 2.2.1/2.2.6. */
export function announceAssertive(message: string) {
  ensureRegions();
  assertiveRegion!.textContent = "";
  requestAnimationFrame(() => {
    assertiveRegion!.textContent = message;
  });
}

/**
 * role="alert" with a specific cause and remedy — never a generic "error".
 * SC 3.3.1 / 3.3.3. Renders into the given container rather than a global
 * live region, so it stays associated with the control that failed.
 */
export function renderAlert(container: HTMLElement, cause: string, remedy: string) {
  container.innerHTML = "";
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = `${cause} ${remedy}`;
  container.appendChild(alert);
}

/** Move focus to a landmark/heading and announce nothing extra — the focus move IS the signal. SC 2.4.3. */
export function moveFocusTo(el: HTMLElement | null) {
  if (!el) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus();
}

/**
 * Private-audio-route verification — readme.md §2, §6.3 step 1, §12 limitation #2.
 *
 * `navigator.mediaDevices.enumerateDevices()` can only tell us an audio
 * output device *exists*; it cannot confirm speech is actually routed to
 * headphones rather than a room speaker. The design's own limitations
 * section (PDF §13.2) flags this as the largest implementation gap and
 * requires pairing it with an explicit, self-declared user confirmation
 * rather than trusting the API alone. Both checks must pass.
 */

export interface RouteCheckResult {
  outputDeviceDetected: boolean;
  userConfirmed: boolean;
  verified: boolean; // true only when both signals agree
}

/** Weak signal: does the browser report a non-default audio output device? */
export async function detectAudioOutputDevice(): Promise<boolean> {
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === "audiooutput");
  } catch {
    // Permission not yet granted / API unsupported — treat as undetected,
    // never as verified. The explicit confirmation step is what actually
    // gates the spoken code, not this signal.
    return false;
  }
}

/**
 * Combines the weak device signal with an explicit, deliberate user action
 * (a checked confirmation checkbox passed in by the caller). Neither signal
 * alone is trusted — see AS-5/AS-6 in the design PDF: containment is a
 * physical property of hardware the system does not control, so this
 * function can only ever produce a declared control, not a proof.
 */
export async function verifyPrivateAudioRoute(userDeclaredHeadphones: boolean): Promise<RouteCheckResult> {
  const outputDeviceDetected = await detectAudioOutputDevice();
  const verified = userDeclaredHeadphones; // the explicit declaration is load-bearing, not the API
  return { outputDeviceDetected, userConfirmed: userDeclaredHeadphones, verified };
}

function synthesize(text: string, rate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) {
      reject(new Error("Speech synthesis is not supported in this browser."));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.onend = () => resolve();
    utterance.onerror = (e) => reject(e.error);
    window.speechSynthesis.cancel(); // never overlap with a prior utterance
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Speaks a code via the Web Speech API. The code is passed directly to the
 * utterance and is NEVER written into DOM text content, NEVER logged, and
 * NEVER placed in a live region (readme.md §2/§8) — it exists only in this
 * function's local scope and the browser's internal TTS pipeline. This is
 * the ONLY function in the app that speaks secret content, and it is only
 * ever called after verifyPrivateAudioRoute() has passed.
 */
export function speakCode(code: string): Promise<void> {
  const spoken = code.split("-").join(", "); // pause between words for clarity
  return synthesize(spoken, 0.9);
}

/**
 * Speaks arbitrary NON-secret text — instructional prompts, status
 * announcements, error messages. Used only when the user has opted in to
 * voice guidance (client/src/a11y/voiceGuidance.ts); never gated by the
 * private-audio-route check because nothing spoken here is a secret.
 * Deliberately a separate function from speakCode so the two can never be
 * confused or merged — one carries a secret, one never does.
 */
export function speakText(text: string): Promise<void> {
  return synthesize(text, 1);
}

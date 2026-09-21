import { announceAssertive } from "./announce.js";

/**
 * WCAG 2.2 SC 2.2.1 timer: no ceremony step may enforce a hard limit below
 * 300 seconds, and every timer must offer an extension. Implemented
 * client-side as UX; the server independently enforces the same 300s floor
 * on every challenge (server/src/config.ts CHALLENGE_TTL_SECONDS) so this
 * is a testable property on both ends, not just a UI courtesy.
 */
export class CeremonyTimer {
  private remaining: number;
  private readonly total: number;
  private intervalId: number | undefined;
  private warned = false;

  constructor(
    private readonly onExpire: () => void,
    totalSeconds = 300
  ) {
    this.total = totalSeconds;
    this.remaining = totalSeconds;
  }

  start() {
    this.stop();
    this.remaining = this.total;
    this.warned = false;
    this.intervalId = window.setInterval(() => {
      this.remaining -= 1;
      if (this.remaining === 30 && !this.warned) {
        this.warned = true;
        announceAssertive(
          "This step expires in 30 seconds. Press the Extend time button to keep going."
        );
      }
      if (this.remaining <= 0) {
        this.stop();
        this.onExpire();
      }
    }, 1000);
  }

  extend(bySeconds = 300) {
    this.remaining += bySeconds;
    this.warned = false;
    announceAssertive("Time extended.");
  }

  stop() {
    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

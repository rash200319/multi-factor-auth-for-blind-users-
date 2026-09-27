/**
 * Out-of-band notification delivery — docs/hardening-plan.md WI-0.
 *
 * IMPORTANT distinction from the banned "email OTP" (readme.md §2, §6.5):
 * this sends informational alerts only ("this happened on your account").
 * It never delivers a code the user types back to authenticate, and grants
 * no access by itself. That's what makes it compliant with the no-email/
 * no-SMS-OTP rule, not an exception to it — do not "fix" this later by
 * routing a real authentication code through this module.
 */

export interface NotificationChannel {
  send(to: string, subject: string, body: string): Promise<void>;
}

class ConsoleChannel implements NotificationChannel {
  async send(to: string, subject: string, body: string) {
    console.log(`[notify] to=${to} subject="${subject}"\n${body}`);
  }
}

let channel: NotificationChannel = new ConsoleChannel();

if (process.env.NOTIFY_CHANNEL === "smtp") {
  const nodemailerModule = await import("nodemailer");
  const transport = nodemailerModule.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  channel = {
    async send(to, subject, body) {
      await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text: body });
    },
  };
}

/** Test-only seam — see server/test/notify.test.ts. */
export function setNotificationChannelForTesting(c: NotificationChannel) {
  channel = c;
}

export type NotificationKind =
  | "stepup_completed"
  | "lockout"
  | "recovery_tier4_requested"
  | "recovery_tier4_cancelled"
  | "recovery_tier4_completed";

const TEMPLATES: Record<NotificationKind, (detail: Record<string, unknown>) => { subject: string; body: string }> = {
  // PDF §7.4: every step-up produces a signal the user receives, so an
  // adversary who races the user to a captured code is noticed.
  stepup_completed: (d) => ({
    subject: "Additional verification was completed on your account",
    body: `A high-value action on your account was verified using your ${d.method === "security_key" ? "security key" : "spoken security code"}. If this wasn't you, use your security key to sign in and replace your registered devices.`,
  }),
  lockout: (d) => ({
    subject: "Your account was locked after repeated failed sign-in attempts",
    body: `Your account was locked until ${d.lockedUntil}. If this wasn't you, no password exists on this system to be stolen, but consider checking your registered devices.`,
  }),
  recovery_tier4_requested: (d) => ({
    subject: "Account recovery was requested",
    body: `A recovery request was made on your account. If you did not make this request, cancel it immediately. It will otherwise take effect at ${d.eligibleAt}.`,
  }),
  recovery_tier4_cancelled: () => ({
    subject: "Account recovery request cancelled",
    body: "A pending recovery request on your account was cancelled.",
  }),
  recovery_tier4_completed: () => ({
    subject: "Account recovery completed",
    body: "Your account recovery request has completed and your account is accessible again, pending a replacement authenticator.",
  }),
};

export async function notifyUser(userEmail: string, kind: NotificationKind, detail: Record<string, unknown> = {}) {
  const { subject, body } = TEMPLATES[kind](detail);
  await channel.send(userEmail, subject, body);
}

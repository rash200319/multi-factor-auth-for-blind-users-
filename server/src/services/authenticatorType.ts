import type { AuthenticatorAttachment, AuthenticatorTransportFuture } from "@simplewebauthn/types";

/**
 * Verifies the authenticator actually used matches what the current
 * enrolment step expects, instead of trusting enrolment order alone.
 *
 * Two signals are available, and they are NOT equally reliable:
 *
 * - `authenticatorAttachment` ('platform' | 'cross-platform') is the
 *   browser's direct statement about how THIS credential was just created —
 *   platform means the device's own built-in authenticator (Windows Hello,
 *   Touch ID), cross-platform means an external one was used. This is
 *   authoritative for this ceremony when present.
 * - `transports` lists what the resulting credential CAN be used with in
 *   general, which is a capability list, not a record of what just
 *   happened. In particular, modern Windows Hello passkeys commonly report
 *   'hybrid' alongside 'internal' — advertising that the passkey could
 *   also be used cross-device later — even when this exact registration
 *   happened locally via PIN/fingerprint on this machine. Treating
 *   "'hybrid' is present" as "a phone was used" is wrong; it has to be
 *   weighed against 'internal' being present too, not checked alone.
 *
 * So: trust `authenticatorAttachment` first. Only fall back to inferring
 * from `transports` when the browser didn't report attachment at all.
 */
export type ExpectedAuthenticatorKind = "laptop" | "phone" | "security_key" | "replacement";

export interface AuthenticatorTypeCheck {
  ok: boolean;
  reason?: string;
}

type Category = "platform" | "hybrid" | "physical" | "unknown";

function classify(
  transports: AuthenticatorTransportFuture[] | undefined,
  authenticatorAttachment: AuthenticatorAttachment | undefined
): Category {
  const t = new Set(transports ?? []);
  const hasInternal = t.has("internal");
  const hasHybrid = t.has("hybrid") || t.has("cable");
  const hasPhysical = t.has("usb") || t.has("nfc") || t.has("ble") || t.has("smart-card");

  if (authenticatorAttachment === "platform") return "platform";
  if (authenticatorAttachment === "cross-platform") {
    // Cross-platform but which kind? Prefer whichever signal is present and
    // unambiguous; if both/neither are, don't guess.
    if (hasHybrid && !hasPhysical) return "hybrid";
    if (hasPhysical && !hasHybrid) return "physical";
    return "unknown";
  }

  // No attachment reported at all (older browser) — fall back to
  // transports, in order of how unambiguous each signal is. 'internal'
  // only ever appears on a genuine platform authenticator, so it wins over
  // 'hybrid' being merely listed as a future capability.
  if (hasInternal) return "platform";
  if (hasHybrid) return "hybrid";
  if (hasPhysical) return "physical";
  return "unknown";
}

export function validateAuthenticatorType(
  expected: ExpectedAuthenticatorKind,
  transports: AuthenticatorTransportFuture[] | undefined,
  authenticatorAttachment: AuthenticatorAttachment | undefined
): AuthenticatorTypeCheck {
  // "replacement" (post-recovery) accepts anything — we don't know in
  // advance what device the user has left, only that it must be a genuine,
  // distinct authenticator (WebAuthn itself already guarantees that).
  if (expected === "replacement") return { ok: true };

  const category = classify(transports, authenticatorAttachment);

  // No usable signal at all — don't block enrolment over a browser
  // limitation; this check is a real detector, not a hard spec guarantee.
  if (category === "unknown") return { ok: true };

  if (expected === "laptop" && category !== "platform") {
    return {
      ok: false,
      reason:
        category === "hybrid"
          ? "That looked like a phone paired over Bluetooth, not this laptop's own fingerprint/Windows Hello/PIN. Use this device's built-in sign-in for step 1."
          : "That looked like a physical security key, not this laptop's own fingerprint/Windows Hello/PIN. Save the security key for step 3.",
    };
  }

  if (expected === "phone" && category !== "hybrid") {
    return {
      ok: false,
      reason:
        category === "platform"
          ? "That used this laptop's built-in sign-in again — step 2 needs your phone, paired via the QR code and Bluetooth prompt."
          : "That looked like a physical security key, not your phone. Step 2 needs your phone, paired via the QR code and Bluetooth prompt. Save the security key for step 3.",
    };
  }

  if (expected === "security_key" && category !== "physical") {
    return {
      ok: false,
      reason:
        category === "hybrid"
          ? "That looked like your phone again, not a physical security key. Step 3 needs a dedicated FIDO2 security key (USB or NFC)."
          : "That used this laptop's built-in sign-in again — step 3 needs a separate, physical FIDO2 security key.",
    };
  }

  return { ok: true };
}

import type { AuthenticatorAttachment, AuthenticatorTransportFuture } from "@simplewebauthn/types";

/**
 * Verifies the authenticator actually used matches what the current
 * enrolment step expects, instead of trusting enrolment order alone.
 *
 * WebAuthn tells us this for free: `transports` (from the credential's own
 * attestation response) says how the browser reached the authenticator —
 * 'hybrid'/'cable' means the cross-device QR+Bluetooth flow (a phone),
 * 'internal' means the platform authenticator built into this browser's
 * device (this laptop), and 'usb'/'nfc'/'ble'/'smart-card' mean a discrete
 * physical authenticator (a roaming security key). `authenticatorAttachment`
 * ('platform' | 'cross-platform') is a second, coarser signal some browsers
 * also report — used to corroborate, not required on its own since support
 * for it is inconsistent.
 */
export type ExpectedAuthenticatorKind = "laptop" | "phone" | "security_key" | "replacement";

export interface AuthenticatorTypeCheck {
  ok: boolean;
  reason?: string;
}

export function validateAuthenticatorType(
  expected: ExpectedAuthenticatorKind,
  transports: AuthenticatorTransportFuture[] | undefined,
  authenticatorAttachment: AuthenticatorAttachment | undefined
): AuthenticatorTypeCheck {
  const t = new Set(transports ?? []);
  const isHybrid = t.has("hybrid") || t.has("cable");
  const isInternal = t.has("internal") || authenticatorAttachment === "platform";
  const isPhysical = t.has("usb") || t.has("nfc") || t.has("ble") || t.has("smart-card");

  // "replacement" (post-recovery) accepts anything — we don't know in
  // advance what device the user has left, only that it must be a genuine,
  // distinct authenticator (WebAuthn itself already guarantees that).
  if (expected === "replacement") return { ok: true };

  // No signal at all (older browser, or the field genuinely wasn't
  // reported) — don't block enrolment over a browser limitation; this
  // check is a real detector, not a hard requirement the spec guarantees.
  if (!isHybrid && !isInternal && !isPhysical) return { ok: true };

  if (expected === "laptop") {
    if (isHybrid) {
      return {
        ok: false,
        reason: "That looked like a phone paired over Bluetooth, not this laptop's own fingerprint/Windows Hello. Use this device's built-in sensor for step 1.",
      };
    }
    if (isPhysical && !isInternal) {
      return {
        ok: false,
        reason: "That looked like a physical security key, not this laptop's own fingerprint/Windows Hello. Save the security key for step 3.",
      };
    }
    return { ok: true };
  }

  if (expected === "phone") {
    if (!isHybrid) {
      return {
        ok: false,
        reason: isInternal
          ? "That used this laptop's built-in sensor again — step 2 needs your phone, paired via the QR code and Bluetooth prompt."
          : "That looked like a physical security key, not your phone. Step 2 needs your phone, paired via the QR code and Bluetooth prompt. Save the security key for step 3.",
      };
    }
    return { ok: true };
  }

  if (expected === "security_key") {
    if (isHybrid) {
      return {
        ok: false,
        reason: "That looked like your phone again, not a physical security key. Step 3 needs a dedicated FIDO2 security key (USB or NFC).",
      };
    }
    if (isInternal) {
      return {
        ok: false,
        reason: "That used this laptop's built-in sensor again — step 3 needs a separate, physical FIDO2 security key.",
      };
    }
    return { ok: true };
  }

  return { ok: true };
}

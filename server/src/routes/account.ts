import { Router } from "express";
import { rows } from "../db/index.js";
import { expectedDeviceForStatus, getUserByEmail, type UserStatus } from "../services/ceremonyApi.js";

export const accountRouter = Router();

const PENDING: UserStatus[] = [
  "PENDING_LAPTOP",
  "PENDING_PHONE",
  "PENDING_KEY",
  "PENDING_CODE_CONFIRM",
];

/**
 * Email-first account lookup — used by Create account (resume), Sign in
 * (lost-device guidance), and Recover. Returns no secrets.
 */
accountRouter.post("/lookup", (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });

  const user = getUserByEmail(email);
  if (!user) {
    return res.json({
      exists: false,
      guidance:
        "No account found for that email. Use Create account to enrol, or check the spelling.",
    });
  }

  const devices = rows<{ device_label: string }>(
    "SELECT device_label FROM credentials WHERE user_id = ? ORDER BY created_at",
    [user.id]
  ).map((d) => d.device_label);

  const nextDevice = expectedDeviceForStatus(user.status);
  const canResumeEnrolment = PENDING.includes(user.status);

  let guidance = "";
  switch (user.status) {
    case "PENDING_LAPTOP":
    case "PENDING_PHONE":
    case "PENDING_KEY":
    case "PENDING_CODE_CONFIRM":
      guidance =
        `Enrolment is unfinished (status: ${user.status}). Open Create account and choose “Resume enrolment” with this email to continue from the next step` +
        (nextDevice ? ` (${nextDevice === "security_key" ? "security key" : nextDevice}).` : " (spoken security code).");
      break;
    case "ACTIVE":
      if (devices.includes("phone") || devices.includes("laptop")) {
        guidance =
          "Account is active. If this laptop is new or lost: Sign in with your phone passkey (or the other registered device). " +
          "If both laptop and phone are gone: use Recover account with a written recovery code" +
          (devices.includes("security_key")
            ? " — or try your security key on Sign in first."
            : ".");
      } else {
        guidance = "Account is active. Use Sign in with your registered passkey.";
      }
      break;
    case "LOCKED":
      guidance =
        "Account is temporarily locked after too many failed security-code attempts. Wait for the lock to expire, or use Recover account if you still have a written recovery code.";
      break;
    case "RECOVERY":
      guidance =
        "Account is in recovery. Open Recover account and register a replacement device to finish restoring access.";
      break;
    default:
      guidance = `Account found (status: ${user.status}).`;
  }

  res.json({
    exists: true,
    userId: canResumeEnrolment ? user.id : undefined, // only hand out id when resuming enrol
    displayName: user.display_name,
    email: user.email,
    status: user.status,
    registeredDevices: devices,
    nextDevice,
    canResumeEnrolment,
    guidance,
  });
});

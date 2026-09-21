export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error ?? `request failed: ${res.status}`) as Error & { data?: unknown; status?: number };
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * WebAuthn calls (`startRegistration`/`startAuthentication`) throw a
 * DOMException with a specific `.name`, not a generic Error — this turns
 * that into a message that actually says what happened, instead of every
 * failure looking the same. The most common one in practice: a cross-device
 * phone registration (QR + Bluetooth) taking longer than the ceremony
 * allows, which surfaces as NotAllowedError.
 */
export function describeAuthenticatorError(err: unknown): string {
  const e = err as { name?: string; message?: string; status?: number; data?: { error?: string } };

  if (e?.name === "NotAllowedError") {
    return "The device did not respond in time, or the prompt was dismissed. If you're pairing a phone, the QR/Bluetooth handshake can take a while on the first try — retry and keep both devices unlocked and nearby.";
  }
  if (e?.name === "InvalidStateError") {
    return "This authenticator is already registered to this account.";
  }
  if (e?.name === "NotSupportedError") {
    return "This browser or device doesn't support the requested passkey options.";
  }
  if (e?.name === "SecurityError") {
    return "The site's address doesn't match what the authenticator expects. Make sure you're on the correct URL.";
  }
  if (e?.name === "AbortError") {
    return "The request was cancelled.";
  }
  if (e?.status) {
    // A rejection from our own API, not from the browser's WebAuthn call.
    return e.data?.error ?? e.message ?? `The server rejected the request (${e.status}).`;
  }
  return e?.message ?? "Something went wrong.";
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error ?? `request failed: ${res.status}`) as Error & { data?: unknown; status?: number };
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

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
    const err = new Error(
      data?.message ?? data?.error ?? `request failed: ${res.status}`
    ) as Error & { data?: any; status?: number };
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * WebAuthn calls (`startRegistration`/`startAuthentication`) throw a
 * DOMException with a specific `.name`, not a generic Error — this turns
 * that into a message that actually says what happened.
 */
export function describeAuthenticatorError(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    status?: number;
    data?: { error?: string; message?: string; reason?: string };
  };

  if (e?.name === "NotAllowedError") {
    return (
      "No passkey was used — either none is registered for this site on this device, " +
      "or the Windows prompt was cancelled. Create an account first, or choose “Windows Hello / this device” " +
      "instead of a USB security key if that dialog appears."
    );
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
    return (
      e.data?.message ??
      e.data?.reason ??
      e.data?.error ??
      e.message ??
      `The server rejected the request (${e.status}).`
    );
  }
  return e?.message ?? "Something went wrong.";
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      data?.message ?? data?.error ?? `request failed: ${res.status}`
    ) as Error & { data?: any; status?: number };
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

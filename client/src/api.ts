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

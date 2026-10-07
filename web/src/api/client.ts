import type { components } from "./schema";

export type Device = components["schemas"]["Device"];
export type Hardware = components["schemas"]["Hardware"];
export type EnrollmentToken = components["schemas"]["EnrollmentToken"];
export type AuditEntry = components["schemas"]["AuditEntry"];
export type SessionInfo = components["schemas"]["SessionInfo"];

let csrfToken = "";

/** Remember the synchronizer token returned by the auth endpoints. */
export function setCsrf(token: string | undefined) {
  csrfToken = token ?? "";
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the REST API. The session cookie is HttpOnly and sent automatically. */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch("/api/v1" + path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? "error", data.error?.message ?? `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

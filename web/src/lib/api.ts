import type { ApiErrorBody } from "../types";

/**
 * HTTP client for the CryptoTrace API.
 *
 * Two things it handles that a bare `fetch` wrapper does not:
 *
 *  1. Single-flight token refresh. The server rotates refresh tokens on every
 *     use, so two concurrent requests that both see a 401 and both refresh will
 *     invalidate each other's token. All waiters share one in-flight refresh.
 *  2. A typed ApiError carrying the server's `error` code, so callers can
 *     branch on `chain_unavailable` or `forbidden` instead of parsing prose.
 */

const STORAGE_KEY = "cryptotrace.session";

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isAuth(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Field-level messages from a zod validation failure. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as { path?: string; message: string }[]) {
      if (d?.path) out[d.path] = d.message;
    }
    return out;
  }
}

type Listener = (session: StoredSession | null) => void;

class ApiClient {
  private base = "";
  private session: StoredSession | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private listeners = new Set<Listener>();
  private onUnauthenticated: (() => void) | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.base = import.meta.env.VITE_API_BASE ?? "";
      this.session = this.readStored();

      // Every tab shares one localStorage key but runs its own JS heap, so the
      // in-memory session drifts from disk as soon as another tab signs in or
      // out. Left unhandled, this tab keeps sending a token the server has
      // already replaced while the UI still believes it holds the old identity
      // — a role gate passes on stale permissions and every request 403s.
      window.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY) return;
        this.adopt(this.readStored());
      });
    }
  }

  /** Called by the auth provider so a hard 401 can drop the session. */
  setUnauthenticatedHandler(fn: () => void): void {
    this.onUnauthenticated = fn;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private readStored(): StoredSession | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredSession;
      if (!parsed?.accessToken || !parsed?.refreshToken) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Point the client at a session and tell subscribers, without touching
   * storage. Used for changes that originate elsewhere — another tab's write,
   * or a token picked up off disk — so adopting one cannot re-trigger a
   * `storage` event in this tab or clobber the newer value.
   */
  private adopt(session: StoredSession | null): void {
    this.session = session;
    for (const fn of this.listeners) fn(session);
  }

  private write(session: StoredSession | null): void {
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private-mode / quota failures are not fatal; the in-memory copy stands.
    }
    this.adopt(session);
  }

  getSession(): StoredSession | null {
    return this.session;
  }

  setSession(session: StoredSession | null): void {
    this.write(session);
  }

  get token(): string | null {
    return this.session?.accessToken ?? null;
  }

  /**
   * Perform a request. `retry` is internal: a 401 triggers exactly one refresh
   * and one replay, so a genuinely expired session surfaces as a real 401
   * instead of looping.
   */
  async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      auth?: boolean;
      raw?: boolean;
    } = {}
  ): Promise<T> {
    const { method = "GET", body, signal, auth = true, raw = false } = options;
    const headers: Record<string, string> = this.headers(auth, raw);
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(0, "network_error", "Could not reach the API. Is the server running?");
    }

    if (res.status === 401 && auth && this.session?.refreshToken) {
      const ok = await this.refresh();
      if (ok) {
        return this.request<T>(path, { ...options, method, body, signal, auth, raw });
      }
      this.onUnauthenticated?.();
    }

    if (res.status === 204) return undefined as T;

    if (!res.ok) {
      let payload: ApiErrorBody | null;
      try {
        payload = (await res.json()) as ApiErrorBody;
      } catch {
        payload = null;
      }
      throw new ApiError(
        res.status,
        payload?.error ?? "http_error",
        payload?.message ?? `Request failed with status ${res.status}`,
        payload?.details,
        res.headers.get("x-request-id") ?? undefined
      );
    }

    if (raw) return (await res.blob()) as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Request headers, including the bearer token when there is a session.
   *
   * Exposed so streaming endpoints can be read with `fetch` and a reader - the
   * SSE stream cannot go through `request`, which buffers the whole body - while
   * still authenticating the same way every other call does.
   */
  authHeaders(): Record<string, string> {
    return this.headers(true, false);
  }

  private headers(auth: boolean, raw: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: raw ? "*/*" : "application/json" };
    if (auth && this.session) headers.authorization = `Bearer ${this.session.accessToken}`;
    return headers;
  }

  /**
   * Single-flight refresh. Concurrent callers await the same promise.
   *
   * The server treats a replayed rotated token as theft and revokes every
   * session for the user, so it is essential that this never presents a token
   * which has already been rotated. Single-flighting covers concurrency inside
   * one tab. Across tabs — one shared `localStorage` session, separate JS
   * heaps — it does not: tab A rotates and writes the new token while tab B is
   * still holding the old one in memory, and B's refresh would be reported as
   * compromise. Re-reading storage immediately before the call picks up a token
   * another tab has already written, so the stale value is never sent.
   */
  private async refresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    // Prefer the freshest token another tab may have persisted. Adopt it
    // through `adopt` rather than assigning the field: this session may belong
    // to a different user, and the UI has to learn that before it gates a route.
    const onDisk = this.readStored();
    if (onDisk?.refreshToken && onDisk.refreshToken !== this.session?.refreshToken) {
      this.adopt(onDisk);
    }

    const token = this.session?.refreshToken;
    if (!token) return false;

    this.refreshInFlight = (async () => {
      try {
        const res = await fetch(`${this.base}/api/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ refreshToken: token })
        });
        if (!res.ok) {
          this.write(null);
          return false;
        }
        const data = (await res.json()) as StoredSession;
        this.write({ accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
        return true;
      } catch {
        // A network blip must not destroy a valid session.
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  get<T>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, { method: "GET", ...opts });
  }

  post<T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, { method: "POST", body, ...opts });
  }

  patch<T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body, ...opts });
  }

  put<T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, { method: "PUT", body, ...opts });
  }

  del<T>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, { method: "DELETE", ...opts });
  }

  /**
   * POST a `multipart/form-data` body.
   *
   * `request()` cannot be reused for this: it sets `content-type: application/json`
   * whenever a body is present, and for multipart the browser must set the header
   * itself so it can include the generated boundary. Setting it by hand produces a
   * body the server cannot parse.
   */
  async upload<T>(path: string, form: FormData, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.session) headers.authorization = `Bearer ${this.session.accessToken}`;

    let res: Response;
    try {
      // No `content-type` header: the browser adds it with the boundary.
      res = await fetch(`${this.base}${path}`, { method: "POST", headers, body: form, signal: opts.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(0, "network_error", "Could not reach the API. Is the server running?");
    }

    if (res.status === 401 && this.session?.refreshToken) {
      const ok = await this.refresh();
      if (ok) return this.upload<T>(path, form, opts);
      this.onUnauthenticated?.();
    }

    if (!res.ok) {
      let payload: ApiErrorBody | null;
      try {
        payload = (await res.json()) as ApiErrorBody;
      } catch {
        payload = null;
      }
      throw new ApiError(
        res.status,
        payload?.error ?? "http_error",
        payload?.message ?? `Upload failed with status ${res.status}`,
        payload?.details,
        res.headers.get("x-request-id") ?? undefined
      );
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Trigger a browser download for a server-generated file. */
  async download(path: string, filename: string): Promise<void> {
    const res = await this.rawRequest(path);

    // A failed export still returns a body — usually a JSON error. Saving that
    // as a ".pdf" produces a file the user cannot open and no message about
    // why, so surface the error instead of writing it to disk.
    //
    // This tests "not an error, and not JSON" rather than allow-listing the
    // types we happen to export today. The allow-list held only application/pdf
    // and application/octet-stream, so the audit CSV — which correctly returns
    // 200 text/csv — was rejected with "Export failed with status 200" and
    // nothing was ever saved.
    const type = res.headers.get("content-type") ?? "";
    const isJson = type.includes("application/json");
    if (!res.ok || isJson) {
      let message = isJson
        ? "The server returned data instead of a downloadable file."
        : `Export failed with status ${res.status}`;
      try {
        const payload = (await res.json()) as ApiErrorBody;
        if (payload?.message) message = payload.message;
      } catch {
        /* keep the fallback message */
      }
      throw new ApiError(res.ok ? 500 : res.status, "export_failed", message);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** GET returning the raw Response, with refresh handling, for file endpoints. */
  private async rawRequest(path: string): Promise<Response> {
    const headers: Record<string, string> = { accept: "*/*" };
    if (this.session) headers.authorization = `Bearer ${this.session.accessToken}`;

    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method: "GET", headers });
    } catch {
      throw new ApiError(0, "network_error", "Could not reach the API. Is the server running?");
    }

    if (res.status === 401 && this.session?.refreshToken) {
      if (await this.refresh()) return this.rawRequest(path);
      this.onUnauthenticated?.();
    }
    return res;
  }

  /** Build a query string, dropping empty values so the server's defaults apply. */
  static qs(params: Record<string, string | number | boolean | undefined | null>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
  }
}

export const api = new ApiClient();

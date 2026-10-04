import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { CaseStreamEvent } from "../types";

/**
 * Query hook for GET endpoints.
 *
 * Requests go through the shared `api` client rather than bare `fetch`, so a
 * query carries the access token, joins a single-flight refresh after a 401, and
 * surfaces a typed `ApiError` carrying the server's error code. Using `fetch`
 * directly here would have left every read on the page unauthenticated and
 * reported a 403 as a bare "HTTP 403" with no way to tell it apart from a 500.
 *
 * `data` is `null` until the first successful fetch, so "not loaded yet" is a
 * single value rather than both `undefined` and `null`.
 */
export function useQuery<T>(url: string | null, deps: unknown[] = []): {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const urlRef = useRef(url);
  const seqRef = useRef(0);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    if (!urlRef.current) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Stops a slower earlier request from overwriting fresher data.
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const json = await api.get<T>(urlRef.current, { signal });
      if (signal.aborted || seq !== seqRef.current) return;
      setData(json);
    } catch (err) {
      if (signal.aborted || seq !== seqRef.current) return;
      setData(null);
      setError(toApiError(err));
    } finally {
      if (!signal.aborted && seq === seqRef.current) setLoading(false);
    }
  }, []);

  const reload = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    void fetchData(controllerRef.current.signal);
  }, [fetchData]);

  // `deps` is the caller's own dependency list, spread in deliberately: the
  // lint rule cannot verify a variable-length array, and dropping it would make
  // a query ignore a dependency it was given. `url` is listed explicitly
  // because it is the value actually fetched.
  useEffect(() => {
    urlRef.current = url;
    reload();
    return () => {
      controllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps, reload]);

  return { data, loading, error, reload };
}

/** Normalises anything thrown by the client or the network into an ApiError. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as Error;
  // An aborted request is not a failure worth reporting; callers already
  // re-run when their inputs change.
  if (e?.name === "AbortError") return new ApiError(0, "aborted", "Request cancelled");
  return new ApiError(0, "network_error", e?.message ?? "Request failed");
}

/**
 * Hook for POST/PATCH/DELETE mutations.
 *
 * Errors are returned rather than thrown and never clear existing data, so a
 * failed action leaves the page showing what it showed before.
 */
export function useMutation<TData, TVariables>(
  url: string,
  options?: {
    method?: "POST" | "PATCH" | "DELETE";
    onSuccess?: (data: TData) => void;
    onError?: (err: ApiError) => void;
  }
): {
  mutate: (variables?: TVariables) => Promise<TData | null>;
  loading: boolean;
  error: ApiError | null;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const mutate = useCallback(
    async (variables?: TVariables): Promise<TData | null> => {
      setLoading(true);
      setError(null);
      try {
        const method = options?.method ?? "POST";
        const data =
          method === "PATCH"
            ? await api.patch<TData>(url, variables)
            : method === "DELETE"
              ? await api.del<TData>(url)
              : await api.post<TData>(url, variables);
        options?.onSuccess?.(data);
        return data;
      } catch (err) {
        const e = toApiError(err);
        setError(e);
        options?.onError?.(e);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [url, options]
  );

  return { mutate, loading, error };
}

/** Value that settles `delay` ms after it stops changing. */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * State mirrored into localStorage.
 *
 * The setter accepts an updater function like `useState` does, because the
 * workspace layout is updated by deriving from previous widths; a value-only
 * setter would force callers to close over stale state and reintroduce the
 * jumping-panel bug.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = (value: T | ((prev: T) => T)) => {
    setStoredValue((prev) => {
      const next = value instanceof Function ? (value as (p: T) => T)(prev) : value;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // An unavailable or full store must not break the session; the layout
        // simply will not persist between visits.
      }
      return next;
    });
  };

  return [storedValue, setValue];
}

/**
 * WebSocket message types from the server.
 */
export interface WSMessage<T = unknown> {
  type: string;
  payload: T;
  timestamp: string;
}

export interface CaseEventPayload {
  caseId: string;
  event: string;
  [key: string]: unknown;
}

/**
 * Resolve the WebSocket endpoint for the API server.
 *
 * Derived from `VITE_API_BASE` so the socket follows the same host as every
 * REST call instead of assuming the dev port. An empty/same-origin base means
 * the current host, which is what a reverse-proxied deployment wants.
 */
function caseEventWsUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = (import.meta.env.VITE_API_BASE ?? "").trim();

  if (base) {
    // VITE_API_BASE may be absolute (https://api.example.com) or a path prefix.
    try {
      const url = new URL(base, window.location.origin);
      return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${url.pathname.replace(/\/$/, "")}`;
    } catch {
      // Fall through to the origin-derived form.
    }
  }
  return `${scheme}//${window.location.host}`;
}

/** Bound on retained events so a long-lived workspace cannot grow without limit. */
const MAX_CACHED_EVENTS = 500;

/**
 * Hook for real-time case event streaming via WebSocket.
 * Live case events over the case WebSocket. Replaces the former SSE stream,
 * which could not authenticate (EventSource cannot set an Authorization header)
 * and kept one long-lived HTTP response per open case.
 */
export function useCaseEventStreamWS(caseId: string | null): {
  events: CaseStreamEvent[];
  status: string | null;
  connected: boolean;
  error: Error | null;
} {
  const [events, setEvents] = useState<CaseStreamEvent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  /**
   * False while the effect is torn down or caseId is empty. `close()` fires
   * `onclose` asynchronously, so without this the handler would schedule a
   * reconnect *after* cleanup already ran and the socket would resurrect
   * itself against an unmounted component.
   */
  const activeRef = useRef(false);
  /** Consecutive failed connects, driving the exponential backoff. */
  const reconnectAttemptsRef = useRef(0);

  const getAccessToken = useCallback((): string | null => {
    return api.getSession()?.accessToken ?? null;
  }, []);

  const connect = useCallback(() => {
    if (!activeRef.current) return;

    const accessToken = getAccessToken();
    if (!caseId || !accessToken) return;

    try {
      const wsUrl = caseEventWsUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", payload: { token: accessToken } }));
      };

      ws.onmessage = (event) => {
        if (!activeRef.current) return;
        try {
          const msg: WSMessage = JSON.parse(event.data);

          switch (msg.type) {
            case "auth_ok":
              // Subscribe to case events after auth
              ws.send(JSON.stringify({
                type: "subscribe",
                payload: { caseId }
              }));
              setConnected(true);
              setError(null);
              reconnectAttemptsRef.current = 0;
              break;

            case "subscribed":
              // Subscription confirmed
              break;

            case "case_event": {
              const payload = msg.payload as CaseEventPayload & { type: string };
              const { type, caseId: _caseId, ...rest } = payload;
              const streamEvent: CaseStreamEvent = {
                type: type as CaseStreamEvent["type"],
                caseId: payload.caseId,
                ...rest
              };
              if (typeof payload.status === "string") setStatus(payload.status);
              setEvents((prev) => [...prev, streamEvent].slice(-MAX_CACHED_EVENTS));
              break;
            }

            case "status-changed": {
              const payload = msg.payload as CaseEventPayload;
              const { caseId: _caseId, ...rest } = payload;
              const streamEvent: CaseStreamEvent = {
                type: "status-changed",
                caseId: payload.caseId,
                ...rest
              };
              if (typeof payload.to_status === "string") setStatus(payload.to_status);
              else if (typeof payload.to === "string") setStatus(payload.to);
              setEvents((prev) => [...prev, streamEvent].slice(-MAX_CACHED_EVENTS));
              break;
            }

            case "heartbeat":
              // Keep-alive, ignore
              break;

            case "pong":
              // Ping response, ignore
              break;

            case "error":
              setError(new Error(msg.payload instanceof Object && "message" in msg.payload
                ? String(msg.payload.message)
                : "WebSocket error"));
              break;

            default:
              // Unknown message type, ignore
              break;
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        // Only reconnect while the subscription is still wanted; a deliberate
        // teardown must not resurrect the socket.
        if (!activeRef.current) return;
        // Exponential backoff with a ceiling, so a server restart does not turn
        // into a tight reconnect storm from every open tab.
        const attempt = reconnectAttemptsRef.current++;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        if (!activeRef.current) return;
        setError(new Error("WebSocket connection error"));
      };
    } catch {
      setError(new Error("Failed to establish WebSocket connection"));
      setConnected(false);
    }
  }, [caseId, getAccessToken]);

  useEffect(() => {
    if (!caseId) {
      activeRef.current = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.close();
      }
      setConnected(false);
      setEvents([]);
      setStatus(null);
      return;
    }

    activeRef.current = true;
    reconnectAttemptsRef.current = 0;
    connect();

    return () => {
      activeRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = undefined;
      }
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.close();
      }
      setConnected(false);
    };
  }, [caseId, connect]);

  /**
   * A refreshed access token leaves the socket authenticated as the old identity:
   * the server authenticates at connect time and has no way to know the token
   * rotated underneath it. Reconnect so permissions are re-checked. Closing here
   * is enough because `onclose` still sees `activeRef` true and reconnects.
   */
  useEffect(() => {
    return api.subscribe((session) => {
      if (!activeRef.current) return;
      const token = session?.accessToken;
      const ws = wsRef.current;
      if (!token || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = undefined;
      }
      ws.close();
    });
  }, []);

  return { events, status, connected, error };
}
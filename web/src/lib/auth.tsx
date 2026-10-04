import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { LoginResponse, Permission, SessionUser } from "../types";

interface AuthValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  can: (...permissions: Permission[]) => boolean;
  canAny: (...permissions: Permission[]) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Whether two session objects describe the same operator. The client hands back
 * a freshly parsed object on every write, so identity is compared by value to
 * keep an unrelated token rotation from re-rendering the whole tree.
 */
function sameIdentity(a: SessionUser | null, b: SessionUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.role === b.role && a.displayName === b.displayName;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Adopt whatever the client restored from storage, then confirm it against
  // the server. A token that survived a restart can still be revoked.
  useEffect(() => {
    const stored = api.getSession();
    if (!stored?.user) {
      setLoading(false);
      return;
    }
    setUser(stored.user as SessionUser);
    let cancelled = false;

    api
      .get<{ user: SessionUser }>("/api/auth/me")
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        const s = api.getSession();
        if (s) api.setSession({ ...s, user: res.user });
      })
      .catch(() => {
        if (cancelled) return;
        // /me failing on an expired token triggers a refresh inside the
        // client; if we still land here, the session is gone.
        setUser(null);
        api.setSession(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    api.setUnauthenticatedHandler(() => setUser(null));
    return () => api.setUnauthenticatedHandler(() => undefined);
  }, []);

  // Track the client session rather than holding an independent copy of it.
  // The client adopts a session from disk when another tab replaces it and when
  // a refresh rotates it, so React state has to follow — otherwise the identity
  // used to gate a route and the token used to call the API come from different
  // users, and the module renders only to 403 on every request inside it.
  useEffect(
    () =>
      api.subscribe((session) => {
        const next = (session?.user as SessionUser | undefined) ?? null;
        setUser((current) => (sameIdentity(current, next) ? current : next));
      }),
    []
  );

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse>("/api/auth/login", { email, password });
    api.setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken, user: res.user });
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = api.getSession()?.refreshToken;
    // Revoke server-side best-effort: a failed network call must not strand
    // the user in a signed-in shell.
    try {
      await api.post("/api/auth/logout", refreshToken ? { refreshToken } : {});
    } catch {
      /* ignore */
    }
    api.setSession(null);
    setUser(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    const res = await api.get<{ user: SessionUser }>("/api/auth/me");
    setUser(res.user);
    const s = api.getSession();
    if (s) api.setSession({ ...s, user: res.user });
  }, []);

  const perms = useMemo(() => new Set<Permission>(user?.permissions ?? []), [user]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshProfile,
      can: (...p) => p.every((x) => perms.has(x)),
      canAny: (...p) => p.some((x) => perms.has(x))
    }),
    [user, loading, login, logout, refreshProfile, perms]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

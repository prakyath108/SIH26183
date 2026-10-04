import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "info" | "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastValue {
  notify: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** Turn any thrown value into a readable message. */
  describeError: (err: unknown) => string;
}

const ToastContext = createContext<ToastValue | null>(null);

const ICONS: Record<ToastKind, string> = { info: "›", success: "✓", error: "!" };
const TTL_MS = 4200;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), TTL_MS);
    },
    [dismiss]
  );

  const describeError = useCallback((err: unknown): string => {
    if (err && typeof err === "object" && "message" in err) {
      const e = err as { message?: unknown };
      if (typeof e.message === "string" && e.message) return e.message;
    }
    if (typeof err === "string") return err;
    return "Something went wrong.";
  }, []);

  const value = useMemo<ToastValue>(
    () => ({
      notify,
      success: (m: string) => notify(m, "success"),
      error: (m: string) => notify(m, "error"),
      describeError
    }),
    [notify, describeError]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toaster" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
            <span className="ico">{ICONS[t.kind]}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

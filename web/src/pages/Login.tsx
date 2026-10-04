import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Notice } from "../components/ui";

export default function Login(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await login(email.trim(), password);
      void navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError("Could not sign in.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-panel">
        <div className="auth-brand">
          <span className="brand-mark lg" aria-hidden="true">
            CT
          </span>
          <div>
            <h1>CryptoTrace AI</h1>
            <p className="chain-tag" style={{ display: "inline-block" }}>
              Investigation Module Terminal
            </p>
          </div>
        </div>

        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <h2>Operator sign-in</h2>
          <p className="muted">Authorised operators only. All access is recorded.</p>

          <label className="field">
            <span className="field-label">Operator ID / Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              placeholder="operator@agency.gov"
              required
              autoFocus
            />
            {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
          </label>

          <label className="field">
            <span className="field-label">Security Token / Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            {fieldErrors.password ? <span className="field-error">{fieldErrors.password}</span> : null}
          </label>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <button className="btn primary block" type="submit" disabled={busy || !email || !password}>
            {busy ? "Authenticating…" : "Authenticate & Deploy"}
          </button>
        </form>

        <div className="auth-foot">
          <strong className="warn-text">Authorised Use Only</strong>
          <p>
            This terminal access is monitored. Every sign-in attempt and every action taken inside the console is written to
            the append-only audit trail and reviewed under your agency&rsquo;s evidence handling policy.
          </p>
          <details>
            <summary>Seeded development accounts</summary>
            <ul className="seed-list">
              <li>
                <code>admin@cryptotrace.local</code> — password from <code>SEED_ADMIN_PASSWORD</code>
              </li>
              <li>
                <code>investigator@cryptotrace.local</code> <code>Investigate!2026x</code>
              </li>
              <li>
                <code>analyst@cryptotrace.local</code> <code>Analyse!2026xy</code>
              </li>
              <li>
                <code>viewer@cryptotrace.local</code> <code>Observe!2026xyz</code>
              </li>
            </ul>
            <p className="field-hint">
              Created by <code>server/src/db/seed.ts</code> for local development only. Change or remove them before any
              shared deployment.
            </p>
          </details>
        </div>
      </div>

      <aside className="auth-aside">
        <h3>What this tool does</h3>
        <ul>
          <li>Traces bounded fund-flow graphs across Bitcoin, Ethereum and Tron.</li>
          <li>Scores addresses with explainable, source-attributed risk factors.</li>
          <li>Collects tamper-evident evidence with verifiable SHA-256 digests.</li>
          <li>Keeps an append-only audit trail of every action taken.</li>
        </ul>
        <h3>What it does not do</h3>
        <ul>
          <li>Identify a person behind an address.</li>
          <li>Prove unlawful conduct on its own.</li>
          <li>Guarantee complete chain coverage. Public endpoints are partial and rate limited.</li>
        </ul>
        <p className="auth-quote">
          Risk scores prioritise review. Treat every figure here as a <span>lead to investigate</span>, never as a
          conclusion.
        </p>
      </aside>
    </div>
  );
}

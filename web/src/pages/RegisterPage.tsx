import { useState, type FormEvent } from "react";
import { useAuth, errorMessage } from "../AuthContext.tsx";

export function RegisterPage({
  onSwitchToLogin,
  onSuccess,
}: {
  onSwitchToLogin: () => void;
  onSuccess: () => void;
}) {
  const { register } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(email, password, fullName);
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-border bg-surface p-6 shadow-xl"
      >
        <h2 className="font-display mb-2 text-2xl font-bold tracking-wide">Register</h2>
        <p className="mb-6 text-sm text-ink-muted">
          Bidding needs a 500 ₾ deposit and team approval after this — see the team once you've
          registered.
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium text-ink-muted">Full name</span>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="w-full rounded border border-border bg-bg px-3 py-2 text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium text-ink-muted">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded border border-border bg-bg px-3 py-2 text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium text-ink-muted">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            className="w-full rounded border border-border bg-bg px-3 py-2 text-ink outline-none focus:border-brand"
          />
        </label>
        {error && <p className="mb-4 text-sm text-brand">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-brand py-2 font-semibold text-white shadow-[0_0_16px_-4px_var(--color-brand)] transition hover:bg-brand-hover disabled:opacity-50"
        >
          {submitting ? "…" : "Register"}
        </button>
        <p className="mt-4 text-center text-sm text-ink-muted">
          Already registered?{" "}
          <button type="button" className="font-medium text-brand hover:underline" onClick={onSwitchToLogin}>
            Log in
          </button>
        </p>
      </form>
    </div>
  );
}

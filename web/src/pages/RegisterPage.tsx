import { useState, type FormEvent } from "react";
import { useAuth, errorMessage } from "../AuthContext.tsx";
import { useTranslation } from "../i18n/index.tsx";

export function RegisterPage({
  onSwitchToLogin,
  onSuccess,
}: {
  onSwitchToLogin: () => void;
  onSuccess: () => void;
}) {
  const { register } = useAuth();
  const { t } = useTranslation();
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
        <h2 className="font-display mb-2 text-2xl font-bold tracking-wide">{t("register.title")}</h2>
        <p className="mb-6 text-sm text-ink-muted">{t("register.explainer")}</p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium text-ink-muted">{t("register.fullName")}</span>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="w-full rounded border border-border bg-bg px-3 py-2 text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium text-ink-muted">{t("register.email")}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded border border-border bg-bg px-3 py-2 text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium text-ink-muted">{t("register.password")}</span>
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
          {submitting ? "…" : t("register.submit")}
        </button>
        <p className="mt-4 text-center text-sm text-ink-muted">
          {t("register.alreadyRegistered")}{" "}
          <button type="button" className="font-medium text-brand hover:underline" onClick={onSwitchToLogin}>
            {t("register.loginLink")}
          </button>
        </p>
      </form>
    </div>
  );
}

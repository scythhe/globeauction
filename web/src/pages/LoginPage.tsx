import { useState, type FormEvent } from "react";
import { useAuth, errorMessage } from "../AuthContext.tsx";

export function LoginPage({
  onSwitchToRegister,
  onSuccess,
}: {
  onSwitchToRegister: () => void;
  onSuccess: () => void;
}) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <h2>Log in</h2>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "..." : "Log in"}
      </button>
      <p>
        No account?{" "}
        <button type="button" className="link" onClick={onSwitchToRegister}>
          Register
        </button>
      </p>
    </form>
  );
}

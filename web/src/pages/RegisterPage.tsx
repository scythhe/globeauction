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
    <form onSubmit={handleSubmit} className="auth-form">
      <h2>Register</h2>
      <p className="hint">
        Bidding needs a 500 GEL deposit and team approval after this — see the team once
        you've registered.
      </p>
      <label>
        Full name
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </label>
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
          minLength={8}
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "..." : "Register"}
      </button>
      <p>
        Already registered?{" "}
        <button type="button" className="link" onClick={onSwitchToLogin}>
          Log in
        </button>
      </p>
    </form>
  );
}

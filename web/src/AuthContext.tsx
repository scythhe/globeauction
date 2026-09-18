import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setToken, type User } from "./api.ts";
import { getCurrentLang } from "./i18n/index.tsx";
import { dict } from "./i18n/translations.ts";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<User>("/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const result = await api.post<{ token: string; user: User }>("/auth/login", {
      email,
      password,
    });
    setToken(result.token);
    setUser(result.user);
  }

  async function register(email: string, password: string, fullName: string) {
    await api.post<User>("/auth/register", { email, password, fullName });
    await login(email, password);
  }

  async function logout() {
    // Best-effort: the session is revoked server-side so a leaked token
    // can't be replayed after logout, but a network hiccup here must
    // still leave the user logged out locally — clear local state either way.
    try {
      await api.post("/auth/logout");
    } catch {
      // ignored — see above
    }
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function errorMessage(err: unknown): string {
  const lang = getCurrentLang();

  if (err instanceof ApiError) {
    // The raw code alone ("rate_limited") reads as a mystery failure —
    // this is exactly the kind of thing that shows up as "bidding feels
    // unreliable" when two people are actually clicking quickly, not when
    // anything is actually broken.
    if (err.code === "rate_limited" && typeof err.extra.retryAfterSeconds === "number") {
      return dict["error.rateLimited"]![lang].replace(
        "{seconds}",
        String(err.extra.retryAfterSeconds),
      );
    }
    // Unmapped codes (a backend error this dictionary hasn't caught up
    // with yet) fall back to the generic message rather than showing the
    // raw snake_case code to a bidder.
    const entry = dict[`error.${err.code}`];
    return entry ? entry[lang] : dict["error.generic"]![lang];
  }
  if (err instanceof Error) return err.message;
  return dict["error.generic"]![lang];
}

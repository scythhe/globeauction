import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setToken, type User } from "./api.ts";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName: string) => Promise<void>;
  logout: () => void;
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

  function logout() {
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
  if (err instanceof ApiError) return err.code;
  if (err instanceof Error) return err.message;
  return "something went wrong";
}

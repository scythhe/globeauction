import { useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { RegisterPage } from "./pages/RegisterPage.tsx";
import { AuctionListPage } from "./pages/AuctionListPage.tsx";
import { AuctionDetailPage } from "./pages/AuctionDetailPage.tsx";
import { TeamPanelPage } from "./pages/TeamPanelPage.tsx";

type View =
  | { name: "list" }
  | { name: "detail"; auctionId: string }
  | { name: "login" }
  | { name: "register" }
  | { name: "team" };

function Shell() {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState<View>({ name: "list" });

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <span className="font-display text-lg tracking-widest text-ink-muted">LOADING…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <button
            type="button"
            className="flex items-center gap-2"
            onClick={() => setView({ name: "list" })}
          >
            <span className="font-display text-2xl font-bold tracking-wide text-ink">
              GLOB<span className="text-brand">AUCTION</span>
            </span>
          </button>
          <nav className="flex items-center gap-3 text-sm">
            {user?.role === "team" && (
              <button
                type="button"
                onClick={() => setView({ name: "team" })}
                className="rounded border border-border px-3 py-1.5 font-medium text-ink-muted transition hover:border-brand hover:text-ink"
              >
                Team panel
              </button>
            )}
            {user ? (
              <>
                <span className="hidden text-ink-muted sm:inline">{user.fullName}</span>
                <button
                  type="button"
                  onClick={logout}
                  className="rounded border border-border px-3 py-1.5 font-medium text-ink-muted transition hover:border-brand hover:text-ink"
                >
                  Log out
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setView({ name: "login" })}
                  className="rounded border border-border px-3 py-1.5 font-medium text-ink-muted transition hover:border-brand hover:text-ink"
                >
                  Log in
                </button>
                <button
                  type="button"
                  onClick={() => setView({ name: "register" })}
                  className="rounded bg-brand px-3 py-1.5 font-semibold text-white shadow-[0_0_16px_-4px_var(--color-brand)] transition hover:bg-brand-hover"
                >
                  Register
                </button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {view.name === "list" && (
          <AuctionListPage onSelect={(auctionId) => setView({ name: "detail", auctionId })} />
        )}
        {view.name === "detail" && (
          <AuctionDetailPage
            auctionId={view.auctionId}
            onBack={() => setView({ name: "list" })}
          />
        )}
        {view.name === "login" && (
          <LoginPage
            onSwitchToRegister={() => setView({ name: "register" })}
            onSuccess={() => setView({ name: "list" })}
          />
        )}
        {view.name === "register" && (
          <RegisterPage
            onSwitchToLogin={() => setView({ name: "login" })}
            onSuccess={() => setView({ name: "list" })}
          />
        )}
        {view.name === "team" && user?.role === "team" && <TeamPanelPage />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

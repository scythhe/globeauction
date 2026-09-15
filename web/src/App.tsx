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

  if (loading) return <p>Loading...</p>;

  return (
    <div className="app">
      <header>
        <button type="button" className="link" onClick={() => setView({ name: "list" })}>
          <h1>globeauction</h1>
        </button>
        <nav>
          {user?.role === "team" && (
            <button type="button" onClick={() => setView({ name: "team" })}>
              Team panel
            </button>
          )}
          {user ? (
            <>
              <span>{user.fullName}</span>
              <button type="button" onClick={logout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setView({ name: "login" })}>
                Log in
              </button>
              <button type="button" onClick={() => setView({ name: "register" })}>
                Register
              </button>
            </>
          )}
        </nav>
      </header>

      <main>
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

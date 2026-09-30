import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AuthCallback } from "./pages/AuthCallback";
import { Spinner } from "./components/ui";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Spinner className="h-8 w-8 text-brand-600" />
      </div>
    );
  }

  const path = window.location.pathname;

  if (path === "/auth/callback") {
    return <AuthCallback />;
  }

  if (!user) {
    return <Login />;
  }

  return <Dashboard />;
}

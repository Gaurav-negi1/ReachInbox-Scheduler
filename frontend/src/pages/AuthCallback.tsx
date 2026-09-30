import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { Spinner } from "../components/ui";

export function AuthCallback() {
  const { setAuth } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setError("No token received from Google sign-in. Please try again.");
      return;
    }
    // Best-effort decode of the JWT payload for display; the server verifies
    // the signature on every /auth/me call.
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      setAuth(token, {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        avatarUrl: payload.avatarUrl ?? null,
      });
      window.history.replaceState({}, "", "/");
    } catch {
      setError("Invalid session token. Please try again.");
    }
  }, [setAuth]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50">
        <div className="max-w-sm rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-inset ring-red-200">
          {error}
        </div>
        <a href="/" className="text-sm font-medium text-brand-600 hover:text-brand-700">
          Back to login
        </a>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50">
      <Spinner className="h-8 w-8 text-brand-600" />
      <p className="text-sm text-gray-500">Signing you in…</p>
    </div>
  );
}

import { useState } from "react";
import { api } from "../api";

/**
 * Login screen: centered 496px card, radius 10px,
 * 1px #E5E7EB border — "Login" title, green "Login with Google" button,
 * "or sign up through email" divider, Email ID + Password fields, green Login.
 *
 * Google is the real auth provider; the email/password form is part of the
 * visual design and explains it cannot be used, keeping the flow honest.
 */
export function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = () => {
    setLoading(true);
    setError(null);
    api
      .googleUrl()
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to start Google login");
        setLoading(false);
      });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-[496px] rounded-[10px] border border-[#E5E7EB] px-8 py-10 sm:px-14">
        <h1 className="text-center text-[40px] font-bold leading-tight text-gray-900">Login</h1>

        <button
          onClick={login}
          disabled={loading}
          className="mt-8 flex w-full items-center justify-center gap-3 rounded-lg bg-brand-50 py-3.5 text-[15px] font-medium text-gray-800 ring-1 ring-inset ring-brand-100 transition hover:bg-brand-100 disabled:opacity-60"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          {loading ? "Redirecting to Google…" : "Login with Google"}
        </button>

        <div className="my-7 flex items-center gap-4">
          <div className="h-px flex-1 bg-gray-200" />
          <span className="text-sm text-gray-400">or sign up through email</span>
          <div className="h-px flex-1 bg-gray-200" />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("Email/password login is not available in this demo — please use Google.");
          }}
          className="space-y-4"
        >
          <input
            type="email"
            placeholder="Email ID"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg bg-gray-100 px-4 py-3.5 text-[15px] text-gray-900 placeholder-gray-400 outline-none transition focus:ring-2 focus:ring-brand-200"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg bg-gray-100 px-4 py-3.5 text-[15px] text-gray-900 placeholder-gray-400 outline-none transition focus:ring-2 focus:ring-brand-200"
          />
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 ring-1 ring-inset ring-red-100">{error}</p>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-brand-500 py-3.5 text-[15px] font-medium text-white transition hover:bg-brand-600"
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
}

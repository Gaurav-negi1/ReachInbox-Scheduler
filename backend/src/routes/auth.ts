import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { config, SESSION_COOKIE } from "../config";
import { logger } from "../logger";
import { requireAuth, signAppToken, signStateToken, toAuthUser } from "../middleware/auth";

const router = Router();

function oauthClient(): OAuth2Client {
  return new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

/**
 * Frontend asks for the Google consent URL.
 * The state is a signed JWT mirrored into an http-only cookie so the
 * callback can reject forged redirects (CSRF protection).
 */
router.get("/google/url", (req: Request, res: Response) => {
  const state = signStateToken({ nonce: crypto.randomBytes(16).toString("hex") });
  res.cookie("g_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.env === "production",
    maxAge: 10 * 60 * 1000,
  });
  const url = oauthClient().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    redirect_uri: config.google.redirectUri,
    state,
    prompt: "select_account",
  });
  res.json({ url });
});

router.get("/google/callback", async (req: Request, res: Response) => {
  const frontend = (req.query.origin as string) || config.frontendUrl;
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const cookieState = (req.cookies as Record<string, string | undefined>)?.g_state;

    if (!code || !state || !cookieState || state !== cookieState) {
      return res.redirect(`${frontend}/?error=auth_state_mismatch`);
    }

    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      return res.redirect(`${frontend}/?error=auth_no_id_token`);
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.google.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      return res.redirect(`${frontend}/?error=auth_profile`);
    }

    const user = await prisma.user.upsert({
      where: { googleId: payload.sub },
      create: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name ?? payload.email,
        avatarUrl: payload.picture ?? null,
      },
      update: {
        email: payload.email,
        name: payload.name ?? payload.email,
        avatarUrl: payload.picture ?? null,
      },
    });

    const appToken = signAppToken(toAuthUser(user));
    res.cookie(SESSION_COOKIE, appToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.env === "production",
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.clearCookie("g_state");
    return res.redirect(`${frontend}/auth/callback?token=${encodeURIComponent(appToken)}`);
  } catch (err) {
    logger.error({ err }, "google oauth callback failed");
    return res.redirect(`${frontend}/?error=auth_failed`);
  }
});

router.post("/logout", (req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

/**
 * Dev-only helper so Postman/curl demos can obtain a bearer token without a
 * browser round-trip. Disabled when NODE_ENV=production.
 */
router.post("/dev-token", async (req: Request, res: Response) => {
  if (config.env === "production") {
    return res.status(404).json({ error: "not found" });
  }
  const email = ((req.body as { email?: string })?.email ?? "demo@reachinbox.test").toLowerCase();
  const name = (req.body as { name?: string })?.name ?? "Demo User";
  // Ensure a real user row exists and sign the token with its DB id so
  // per-user foreign keys (senders, emails, Slack) resolve correctly.
  const user = await prisma.user.upsert({
    where: { email },
    create: { googleId: `dev:${email}`, email, name },
    update: {},
  });
  const token = signAppToken(toAuthUser(user));
  res.json({ token });
});

export default router;

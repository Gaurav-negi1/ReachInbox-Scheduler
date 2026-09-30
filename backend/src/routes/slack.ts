import { Router } from "express";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { config } from "../config";
import { requireAuth, signStateToken } from "../middleware/auth";
import { logger } from "../logger";

const router = Router();

/**
 * Slack "Connect" flow:
 *  1. GET /api/slack/connect (from dashboard, with app JWT) -> signed state
 *     cookie + Slack authorize URL.
 *  2. Slack redirects to /api/slack/callback with code+state.
 *  3. We exchange code -> access token, call auth.test for team info, and try
 *     to look up an incoming webhook (incoming-webhooks scope). Webhook is
 *     preferred for notifications; bot token (chat.postMessage) is fallback.
 *  4. Status endpoint tells the dashboard whether Slack is connected.
 */
router.get("/connect", requireAuth, (req, res) => {
  const state = signStateToken({ userId: req.user!.id, nonce: Math.random().toString(36).slice(2) });
  res.cookie("slack_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.env === "production",
    maxAge: 10 * 60 * 1000,
  });
  const url =
    "https://slack.com/oauth/v2/authorize" +
    `?client_id=${encodeURIComponent(config.slack.clientId)}` +
    `&scope=chat:write,incoming-webhook,channels:read` +
    `&redirect_uri=${encodeURIComponent(config.slack.redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

router.get("/callback", async (req, res) => {
  const frontend = config.frontendUrl;
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const cookieState = req.cookies?.slack_oauth_state as string | undefined;

  if (!code || !state || !cookieState || state !== cookieState) {
    return res.redirect(`${frontend}/settings?slack=state_mismatch`);
  }

  try {
    const tokenResp = await axios.post(
      "https://slack.com/api/oauth.v2.access",
      new URLSearchParams({
        client_id: config.slack.clientId,
        client_secret: config.slack.clientSecret,
        code: code!,
        redirect_uri: config.slack.redirectUri,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const data = tokenResp.data as {
      ok: boolean;
      error?: string;
      team?: { id: string; name: string };
      access_token?: string;
      incoming_webhook?: { url?: string; channel?: string };
    };
    if (!data.ok || !data.access_token) {
      logger.error({ slackError: data.error }, "slack oauth failed");
      return res.redirect(`${frontend}/settings?slack=${encodeURIComponent(data.error ?? "failed")}`);
    }

    let channel = data.incoming_webhook?.channel ?? null;
    const botToken = data.access_token;
    try {
      const authTest = await axios.post(
        "https://slack.com/api/auth.test",
        {},
        { headers: { Authorization: `Bearer ${botToken}` } }
      );
      const teamId = (authTest.data as { team_id?: string }).team_id;
      logger.info({ teamId }, "slack auth.test ok");
    } catch {
      // non-fatal
    }

    const userId = JSON.parse(Buffer.from(state.split(".")[1], "base64").toString()) as { userId?: string };
    await prisma.user.update({
      where: { id: userId.userId! },
      data: {
        slackBotToken: botToken,
        slackWebhook: data.incoming_webhook?.url ?? null,
        slackChannel: channel,
        slackTeamId: data.team?.id ?? null,
        slackTeamName: data.team?.name ?? null,
      },
    });

    return res.redirect(`${frontend}/settings?slack=connected`);
  } catch (err) {
    logger.error({ err }, "slack callback failed");
    return res.redirect(`${frontend}/settings?slack=failed`);
  }
});

router.get("/status", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  res.json({
    connected: Boolean(user?.slackBotToken || user?.slackWebhook),
    teamName: user?.slackTeamName ?? null,
    channel: user?.slackChannel ?? null,
  });
});

router.post("/disconnect", requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      slackBotToken: null,
      slackWebhook: null,
      slackChannel: null,
      slackTeamId: null,
      slackTeamName: null,
    },
  });
  res.json({ ok: true });
});

export default router;

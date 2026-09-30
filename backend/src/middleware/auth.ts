import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config, SESSION_COOKIE } from "../config";
import type { User } from "@prisma/client";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
};

export function toAuthUser(u: User): AuthUser {
  return { id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl ?? null };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type AppJwtPayload = {
  sub: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
};

export function signAppToken(user: { id: string; email: string; name: string; avatarUrl: string | null }): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
    config.sessionSecret,
    { expiresIn: "7d" }
  );
}

export function signStateToken(extra: Record<string, unknown>): string {
  return jwt.sign(extra, config.sessionSecret, { expiresIn: "10m" });
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const cookie = req.cookies?.[SESSION_COOKIE];
  return typeof cookie === "string" && cookie.length > 0 ? cookie : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(token, config.sessionSecret) as AppJwtPayload;
    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.avatarUrl ?? null,
    };
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}

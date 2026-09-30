import "dotenv/config";
import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "path";
import fs from "fs";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config";
import { emailQueue } from "./lib/queue";
import authRoutes from "./routes/auth";
import emailRoutes from "./routes/emails";
import slackRoutes from "./routes/slack";
import statsRoutes from "./routes/stats";
import { logger } from "./logger";

function basicAuth(
  user: string,
  pass: string
): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header) {
      const [scheme, encoded] = header.split(" ");
      if (scheme === "Basic" && encoded) {
        const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
        if (u === user && p === pass) return next();
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="bull-board", charset="UTF-8"');
    res.status(401).send("401 Unauthorized");
  };
}

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { secure: config.env === "production", sameSite: "lax" },
    })
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    })
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // Live BullMQ dashboard at /admin/queues, protected by HTTP basic auth.
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter: bullBoardAdapter,
  });
  app.use(
    "/admin/queues",
    basicAuth(config.bullBoardUser, config.bullBoardPassword),
    bullBoardAdapter.getRouter()
  );

  app.use("/api/auth", authRoutes);
  app.use("/api/emails", emailRoutes);
  app.use("/api/slack", slackRoutes);
  app.use("/api/stats", statsRoutes);

  // In production, serve the built React app (frontend/dist) from this same
  // origin so the deployment exposes a single URL and the frontend's relative
  // /api calls work without extra CORS/proxy configuration.
  const frontendDist = path.resolve(__dirname, "../../frontend/dist");
  if (config.env === "production" && fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req, res) => res.sendFile(path.join(frontendDist, "index.html")));
  } else {
    app.use((_req, res) => {
      res.status(404).json({ error: "not found" });
    });
  }

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      logger.error({ err: err.message }, "unhandled error");
      res.status(500).json({ error: "internal server error" });
    }
  );

  return app;
}

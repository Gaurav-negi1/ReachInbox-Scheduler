import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";

/**
 * Express 4 does not forward rejections from async handlers to the error
 * middleware: a failed Prisma/Redis call inside `async (req, res) => {...}`
 * becomes an unhandled rejection (request hangs; on Node >= 15 the process
 * can crash — taking the embedded worker with it). This Router wraps every
 * handler so rejections reach `next(err)` and become a clean 500.
 */
function wrap(fn: RequestHandler): RequestHandler {
  if (fn.length >= 4) return fn; // error-handling middleware: leave alone
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = fn(req, res, next) as unknown;
      if (out && typeof (out as Promise<unknown>).catch === "function") {
        (out as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

export function safeRouter(): Router {
  const router = Router();
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const original = router[method].bind(router) as (path: unknown, ...h: RequestHandler[]) => Router;
    (router as unknown as Record<string, unknown>)[method] = (path: unknown, ...handlers: RequestHandler[]) =>
      original(path, ...handlers.map(wrap));
  }
  return router;
}

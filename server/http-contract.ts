import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { z } from "zod";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const tokenBody = z.object({ token: tokenSchema }).strict();
export const campaignSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(2000),
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,5})?$/)
      .refine((v) => Number(v) > 0),
    slots: z.number().int().min(1).max(1000),
    expires: z.number().int(),
  })
  .strict();

export function securityHeaders(res: ServerResponse, origin: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (origin.startsWith("https:"))
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
}
export async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) {
      req.resume();
      fail(413, "Request too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(400, "Invalid JSON.");
  }
}
export function serveStatic(
  path: string,
  res: ServerResponse,
  directory?: string,
) {
  if (!directory) {
    res.writeHead(404);
    res.end("Use the Vite development server.");
    return;
  }
  const root = resolve(directory);
  const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
  if (!file.startsWith(`${root}/`)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const target = existsSync(file) ? file : resolve(root, "index.html");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  try {
    const data = readFileSync(target);
    res.writeHead(200, {
      "Content-Type": types[extname(target)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Build the client first.");
  }
}

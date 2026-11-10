import { createServer, request } from "node:http";
// Explicit public gateway surface. Fragments never reach this HTTP boundary.
export function stagingRoute(method: string, path: string) {
  if (method === "GET")
    return (
      path === "/" ||
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path) ||
      ["/healthz", "/api/config", "/api/session", "/api/campaigns"].includes(
        path,
      ) ||
      /^\/api\/campaigns\/[a-f0-9-]{36}$/.test(path)
    );
  if (method !== "POST") return false;
  return (
    [
      "/api/login",
      "/api/logout",
      "/api/invitation",
      "/api/challenge",
      "/api/claim",
      "/api/campaigns",
    ].includes(path) ||
    /^\/api\/campaigns\/[a-f0-9-]{36}\/invitations$/.test(path) ||
    /^\/api\/claims\/[a-f0-9-]{36}\/decision$/.test(path)
  );
}
export function stagingGateway(
  backendPort: number,
  origin: string,
  route = stagingRoute,
) {
  const gateway = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const deny = () => {
      res.writeHead(404);
      res.end();
    };
    // No decoding, URL normalization, alternate hosts or forwarded-header trust.
    if (
      req.headers.host !== new URL(origin).host ||
      !route(req.method ?? "", req.url ?? "")
    )
      return deny();
    const headers = { ...req.headers };
    for (const key of Object.keys(headers))
      if (
        key.startsWith("x-forwarded-") ||
        ["forwarded", "connection", "upgrade", "proxy-authorization"].includes(
          key,
        )
      )
        delete headers[key];
    if (["/api/invitation", "/api/challenge", "/api/claim"].includes(req.url!))
      delete headers.cookie;
    const upstream = request(
      {
        host: "127.0.0.1",
        port: backendPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
  gateway.requestTimeout = 15_000;
  gateway.headersTimeout = 10_000;
  return gateway;
}

import { isIPv4 } from "node:net";
export function privateIpv4(ip: string) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}
export function mobileCaddyfile(
  bindIp: string,
  phoneIp: string,
  port = 8443,
  apiPort = 3002,
) {
  if (!privateIpv4(bindIp) || !privateIpv4(phoneIp) || bindIp === phoneIp)
    throw new Error(
      "Distinct private IPv4 laptop and phone addresses are required.",
    );
  for (const value of [port, apiPort])
    if (!Number.isInteger(value) || value < 1024 || value > 65535)
      throw new Error("Use an unprivileged valid port.");
  return `{
  admin off
  auto_https disable_redirects
  skip_install_trust
}
https://${bindIp}:${port} {
  bind ${bindIp}
  tls internal
  route {
    @spending path_regexp spending ^/api/(claims/[^/]+/payment/reserve|payments/[^/]+/dispatch)$
    respond @spending "Native payment dispatch is disabled for mobile testing" 403
    @laptop remote_ip ${bindIp}
    handle @laptop {
      reverse_proxy 127.0.0.1:${apiPort}
    }
    @phoneRead {
      remote_ip ${phoneIp}
      method GET
      path / /assets/* /api/config
    }
    handle @phoneRead {
      reverse_proxy 127.0.0.1:${apiPort} {
        header_up -Cookie
      }
    }
    @phoneClaim {
      remote_ip ${phoneIp}
      method POST
      path /api/invitation /api/challenge /api/claim
    }
    handle @phoneClaim {
      reverse_proxy 127.0.0.1:${apiPort} {
        header_up -Cookie
      }
    }
    respond "Private mobile recipient test only" 403
  }
}
`;
}

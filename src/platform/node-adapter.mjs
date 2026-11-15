import {CLIENT_IP_HEADER} from './accounts.mjs';

const MAX_BODY = 100_000;

/** Node edge for the composed Fetch handler. The configured public origin is
 * authoritative: Host and client forwarding headers never select the origin,
 * and the rate-limit client address is derived here, not by the client. */
export function createNodeListener(handle, {publicOrigin, trustedProxyHops = 0}) {
  const origin = new URL(publicOrigin);
  const reply = (res, status, code) => {
    res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
    res.end(JSON.stringify({error: code}));
  };
  return async (req, res) => {
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, 'INVALID_TARGET');
      const url = new URL(req.url, origin);
      if (url.origin !== origin.origin) return reply(res, 400, 'INVALID_TARGET');
      const method = req.method || 'GET';
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || key === CLIENT_IP_HEADER) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      let client = req.socket.remoteAddress ?? 'unknown';
      if (trustedProxyHops > 0) {
        const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map(v => v.trim()).filter(Boolean);
        if (chain.length >= trustedProxyHops) client = chain[chain.length - trustedProxyHops];
      }
      headers.set(CLIENT_IP_HEADER, client.slice(0, 64));
      let body;
      if (!['GET', 'HEAD'].includes(method)) {
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > MAX_BODY) return reply(res, 413, 'BODY_TOO_LARGE');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) return reply(res, 413, 'BODY_TOO_LARGE');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const response = await handle(new Request(url, {method, headers, ...(body === undefined ? {} : {body})}));
      const outgoing = {};
      for (const [key, value] of response.headers) if (key !== 'set-cookie') outgoing[key] = value;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing['set-cookie'] = cookies;
      res.writeHead(response.status, outgoing);
      res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) reply(res, 503, 'SERVICE_UNAVAILABLE');
      else res.destroy();
    }
  };
}

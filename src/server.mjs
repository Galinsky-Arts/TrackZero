import {createOnboardingHandler} from './onboarding.mjs';

/** Node HTTP boundary for the onboarding handler. TLS termination must preserve
 * the configured public origin; client Host and forwarded headers are ignored.
 * The caller owns the server, storage lifecycle, and trusted auth adapter.
 */
export function createOnboardingNodeHandler({store, authenticate, publicOrigin}) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('HTTPS public origin required');
  }
  const handle = createOnboardingHandler(store, authenticate);

  return async function nodeHandler(req, res) {
    const reply = (status, code) => {
      res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      res.end(JSON.stringify({error: code}));
    };
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) return reply(400, 'INVALID_TARGET');
      const url = new URL(req.url, origin);
      if (url.origin !== origin.origin) return reply(400, 'INVALID_TARGET');
      const method = req.method || 'GET';
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      let body;
      if (method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return reply(413, 'BODY_TOO_LARGE');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const response = await handle(new Request(url, {method, headers, ...(body === undefined ? {} : {body})}));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) reply(503, 'ONBOARDING_UNAVAILABLE');
      else res.destroy();
    }
  };
}

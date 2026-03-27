/**
 * Azure Functions v4 ↔ Vercel Serverless compatibility adapter.
 *
 * Wraps a Vercel-style handler  (req, res) => void
 * so it works as an Azure Functions v4 HTTP handler
 * returning an HttpResponseInit object.
 */

const { parse } = require('querystring');
const { URL } = require('url');

/**
 * Convert an Azure Functions HttpRequest into a Vercel-like req object
 * and capture the response written by the Vercel handler.
 */
function wrapVercelHandler(vercelHandler) {
  return async function azureHandler(request, context) {
    // ── Build Vercel-compatible "req" ──────────────────────────
    const url = new URL(request.url);

    // Parse query params
    const query = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    // Parse cookies from header
    const cookieHeader = request.headers.get('cookie') || '';
    const cookies = {};
    cookieHeader.split(';').forEach(c => {
      const [k, ...rest] = c.trim().split('=');
      if (k) cookies[k] = rest.join('=');
    });

    // Read body
    let body = null;
    const contentType = request.headers.get('content-type') || '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        if (contentType.includes('application/json')) {
          body = await request.json();
        } else if (contentType.includes('multipart/form-data')) {
          // For file uploads — pass raw body as Buffer
          body = Buffer.from(await request.arrayBuffer());
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          const text = await request.text();
          body = parse(text);
        } else {
          // Try JSON, fall back to text
          const text = await request.text();
          try { body = JSON.parse(text); } catch { body = text; }
        }
      } catch (e) {
        body = null;
      }
    }

    // Build headers object (lowercased keys like Node http.IncomingMessage)
    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      cookies,
      query,
      body,
      // For multipart uploads, store the raw request for parsing
      _azureRequest: request,
    };

    // ── Build Vercel-compatible "res" (capture output) ────────
    let statusCode = 200;
    const resHeaders = {};
    let resBody = null;
    let ended = false;

    const res = {
      statusCode: 200,

      status(code) {
        statusCode = code;
        res.statusCode = code;
        return res;
      },

      setHeader(key, value) {
        // Support Set-Cookie arrays
        if (key.toLowerCase() === 'set-cookie') {
          if (!resHeaders['set-cookie']) {
            resHeaders['set-cookie'] = [];
          }
          if (Array.isArray(value)) {
            resHeaders['set-cookie'].push(...value);
          } else {
            resHeaders['set-cookie'].push(value);
          }
        } else {
          resHeaders[key.toLowerCase()] = value;
        }
        return res;
      },

      getHeader(key) {
        return resHeaders[key.toLowerCase()];
      },

      writeHead(code, hdrs) {
        statusCode = code;
        if (hdrs) {
          Object.entries(hdrs).forEach(([k, v]) => res.setHeader(k, v));
        }
        return res;
      },

      write(chunk) {
        if (resBody === null) resBody = '';
        resBody += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      },

      end(data) {
        if (data !== undefined && data !== null) {
          if (Buffer.isBuffer(data)) {
            resBody = data;
          } else if (typeof data === 'string') {
            resBody = (resBody || '') + data;
          } else {
            resBody = (resBody || '') + String(data);
          }
        }
        ended = true;
        return res;
      },

      json(obj) {
        resHeaders['content-type'] = 'application/json';
        resBody = JSON.stringify(obj);
        ended = true;
        return res;
      },

      send(data) {
        if (typeof data === 'object' && !Buffer.isBuffer(data)) {
          return res.json(data);
        }
        resBody = data;
        ended = true;
        return res;
      },

      redirect(urlOrStatus, url) {
        if (typeof urlOrStatus === 'number') {
          statusCode = urlOrStatus;
          resHeaders['location'] = url;
        } else {
          statusCode = 302;
          resHeaders['location'] = urlOrStatus;
        }
        ended = true;
        return res;
      },
    };

    // ── Execute the original Vercel handler ────────────────────
    try {
      await vercelHandler(req, res);
    } catch (err) {
      context.log('Handler error:', err);
      statusCode = 500;
      resHeaders['content-type'] = 'application/json';
      resBody = JSON.stringify({ error: 'Internal server error' });
    }

    // ── Convert to Azure Functions HttpResponseInit ────────────
    const responseHeaders = {};
    for (const [k, v] of Object.entries(resHeaders)) {
      // Skip set-cookie from headers — use the dedicated cookies property instead.
      // RFC 6265 forbids comma-joining Set-Cookie headers, and Azure Functions v4
      // handles cookies correctly via the cookies array.
      if (k === 'set-cookie') continue;
      responseHeaders[k] = v;
    }

    // Parse Set-Cookie strings into Azure Functions cookie objects
    const parsedCookies = resHeaders['set-cookie']
      ? resHeaders['set-cookie'].map(parseCookie)
      : undefined;

    return {
      status: statusCode,
      headers: responseHeaders,
      body: resBody,
      cookies: parsedCookies,
    };
  };
}

/**
 * Parse a Set-Cookie string into an Azure Functions cookie object.
 */
function parseCookie(cookieStr) {
  const parts = cookieStr.split(';').map(p => p.trim());
  const [nameVal, ...attrs] = parts;
  const eqIdx = nameVal.indexOf('=');
  const name = nameVal.substring(0, eqIdx);
  const value = nameVal.substring(eqIdx + 1);

  const cookie = { name, value };
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower === 'httponly') cookie.httpOnly = true;
    else if (lower === 'secure') cookie.secure = true;
    else if (lower.startsWith('path=')) cookie.path = attr.split('=')[1];
    else if (lower.startsWith('domain=')) cookie.domain = attr.split('=')[1];
    else if (lower.startsWith('samesite=')) cookie.sameSite = attr.split('=')[1];
    else if (lower.startsWith('max-age=')) cookie.maxAge = parseInt(attr.split('=')[1]);
    else if (lower.startsWith('expires=')) cookie.expires = new Date(attr.substring(8));
  }
  return cookie;
}

module.exports = { wrapVercelHandler };

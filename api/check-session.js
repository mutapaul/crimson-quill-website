const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not configured');
}

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action || '';

  // ── CSRF Token (GET or POST with ?action=csrf) ──
  if (action === 'csrf') {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const csrfToken = crypto.randomBytes(32).toString('hex');
      const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Production' || process.env.WEBSITE_SITE_NAME;

      const cookieOptions = [
        `cq_csrf=${csrfToken}`,
        'Path=/',
        'SameSite=Strict',
        `Max-Age=${60 * 60}`, // 1 hour
      ];
      if (isProduction) {
        cookieOptions.push('Secure');
      }

      res.setHeader('Set-Cookie', cookieOptions.join('; '));
      return res.status(200).json({ csrfToken, success: true });
    } catch (error) {
      console.error('csrf-token error:', error);
      return res.status(500).json({ error: 'An internal error occurred' });
    }
  }

  // ── Logout (POST or DELETE without ?action) ──
  if (req.method === 'POST' || req.method === 'DELETE') {
    try {
      const logoutTimestamp = Date.now();
      const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Production' || process.env.WEBSITE_SITE_NAME;

      const sessionCookieOptions = [
        'cq_session=',
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
      ];
      if (isProduction) {
        sessionCookieOptions.push('Secure');
      }

      const logoutCookieOptions = [
        `cq_logged_out=${logoutTimestamp}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${24 * 60 * 60}`,
      ];
      if (isProduction) {
        logoutCookieOptions.push('Secure');
      }

      const userCookieOptions = [
        'cq_user=',
        'Path=/',
        'SameSite=Lax',
        'Max-Age=0',
      ];
      if (isProduction) {
        userCookieOptions.push('Secure');
      }

      res.setHeader('Set-Cookie', [
        sessionCookieOptions.join('; '),
        logoutCookieOptions.join('; '),
        userCookieOptions.join('; '),
      ]);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('logout error:', error);
      return res.status(500).json({ error: 'An unexpected error occurred.' });
    }
  }

  // ── Check Session (GET) ──
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('cq_session='));

    if (!sessionCookie) {
      return res.status(401).json({ authenticated: false });
    }

    const token = sessionCookie.split('=')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if user has logged out after token was issued
    const logoutCookie = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('cq_logged_out='));

    if (logoutCookie) {
      const logoutTimestamp = parseInt(logoutCookie.split('=')[1], 10);
      const tokenIssuedAt = decoded.iat * 1000;

      if (logoutTimestamp >= tokenIssuedAt) {
        return res.status(401).json({ authenticated: false, error: 'Session revoked' });
      }
    }

    return res.status(200).json({
      authenticated: true,
      email: decoded.email,
      portalType: decoded.portalType,
      authenticatedAt: decoded.authenticatedAt,
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ authenticated: false, error: 'Session expired' });
    }
    return res.status(401).json({ authenticated: false });
  }
};

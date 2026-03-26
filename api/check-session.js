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

  // ── Setup MatterAccess List (GET with ?action=setup-list&key=cq2026) ── TEMPORARY
  if (action === 'setup-list') {
    if (req.query.key !== 'cq2026') return res.status(403).json({ error: 'Forbidden' });
    try {
      const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
      const sc = cookies.find(c => c.startsWith('cq_session='));
      if (!sc) return res.status(401).json({ error: 'Login first' });
      jwt.verify(sc.split('=')[1], JWT_SECRET);
    } catch (e) { return res.status(401).json({ error: 'Bad session' }); }
    try {
      const body = new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      });
      const tr = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      });
      if (!tr.ok) return res.status(500).json({ error: 'Token failed' });
      const { access_token: token } = await tr.json();
      const sr = await fetch('https://graph.microsoft.com/v1.0/sites/cqadvocates.sharepoint.com:/sites/CQClientPortal', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const site = await sr.json();
      const siteId = site.id;
      const lr = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const lists = await lr.json();
      const existing = (lists.value || []).find(l => l.displayName === 'MatterAccess');
      if (existing) return res.status(200).json({ success: true, message: 'Already exists', listId: existing.id });
      const cr = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'MatterAccess', list: { template: 'genericList' } }),
      });
      if (!cr.ok) { const e = await cr.text(); return res.status(500).json({ error: 'Create failed', d: e }); }
      const list = await cr.json();
      const lid = list.id;
      const cols = [
        { name: 'Email', text: { maxLength: 255 }, required: true },
        { name: 'PersonName', text: { maxLength: 255 } },
        { name: 'Matter_x0020_ID', text: { maxLength: 100 }, required: true },
        { name: 'MatterTitle', text: { maxLength: 255 } },
        { name: 'AccessLevel', choice: { choices: ['View Only', 'Contributor'], displayAs: 'dropDownMenu' }, defaultValue: { value: 'View Only' } },
        { name: 'GrantedBy', text: { maxLength: 255 } },
        { name: 'GrantedDate', text: { maxLength: 50 } },
      ];
      const results = [];
      for (const col of cols) {
        const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${lid}/columns`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(col),
        });
        results.push({ name: col.name, ok: r.ok });
      }
      return res.status(200).json({ success: true, listId: lid, columns: results });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CSRF Token (GET or POST with ?action=csrf) ──
  if (action === 'csrf') {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const csrfToken = crypto.randomBytes(32).toString('hex');
      const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

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
      const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

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

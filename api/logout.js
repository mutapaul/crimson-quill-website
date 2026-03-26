module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get current timestamp for logout marker
    const logoutTimestamp = Date.now();
    const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

    // Clear session cookie with Max-Age=0 to expire it immediately
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

    // Set logout timestamp cookie (readable by server, tracks when logout occurred)
    // This is used by check-session.js to invalidate any tokens issued before this time
    const logoutCookieOptions = [
      `cq_logged_out=${logoutTimestamp}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${24 * 60 * 60}`, // 24 hours - same as JWT expiry
    ];
    if (isProduction) {
      logoutCookieOptions.push('Secure');
    }

    // Also clear user info cookie (client-readable)
    const userCookieOptions = [
      'cq_user=',
      'Path=/',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (isProduction) {
      userCookieOptions.push('Secure');
    }

    // Set all cookies
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
};

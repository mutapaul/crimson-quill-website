const crypto = require('crypto');

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET and POST
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Generate a random CSRF token (32 bytes = 64 hex characters)
    const csrfToken = crypto.randomBytes(32).toString('hex');

    // Determine if production
    const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

    // Set the CSRF token as a cookie
    // httpOnly: false so JavaScript can read it and include it in headers
    // secure: true in production, sameSite: Strict to prevent cross-site requests
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

    // Return the token in JSON response
    return res.status(200).json({
      csrfToken,
      success: true,
    });
  } catch (error) {
    console.error('csrf-token error:', error);
    return res.status(500).json({ error: 'An internal error occurred' });
  }
};

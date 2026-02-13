const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse cookie
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('cq_session='));

    if (!sessionCookie) {
      return res.status(401).json({ authenticated: false });
    }

    const token = sessionCookie.split('=')[1];

    // Verify JWT
    const decoded = jwt.verify(token, JWT_SECRET);

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

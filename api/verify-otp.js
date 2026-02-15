const jwt = require('jsonwebtoken');
const { createClient } = require('@vercel/kv');
const { getOTP, incrementAttempts, deleteOTP } = require('./lib/otp');

const JWT_SECRET = process.env.JWT_SECRET;
const SHAREPOINT_URL = process.env.SHAREPOINT_SITE_URL || 'https://cqadvocates.sharepoint.com/sites/CQClientPortal';

// Portal URLs on the main website (branded wrappers)
const PORTAL_URLS = {
  client: '/client',
  staff: '/staff',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, code, portalType } = req.body;

    if (!email || !code || !portalType) {
      return res.status(400).json({ error: 'Email, code, and portal type are required.' });
    }

    if (!['client', 'staff'].includes(portalType)) {
      return res.status(400).json({ error: 'Invalid portal type.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Initialize Vercel KV
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // Retrieve stored OTP
    const otpData = await getOTP(kv, normalizedEmail);

    if (!otpData) {
      return res.status(400).json({
        error: 'Verification code has expired. Please request a new one.',
      });
    }

    // Check max attempts (3)
    if (otpData.attempts >= 3) {
      await deleteOTP(kv, normalizedEmail);
      return res.status(400).json({
        error: 'Too many failed attempts. Please request a new code.',
      });
    }

    // Verify code
    if (otpData.code !== code.trim()) {
      await incrementAttempts(kv, normalizedEmail);
      const remaining = 2 - otpData.attempts;
      return res.status(400).json({
        error: remaining > 0
          ? `Incorrect code. ${remaining + 1} attempt${remaining > 0 ? 's' : ''} remaining.`
          : 'Incorrect code. Please request a new verification code.',
      });
    }

    // OTP is correct â clean up
    await deleteOTP(kv, normalizedEmail);

    // Generate JWT session token
    const token = jwt.sign(
      {
        email: normalizedEmail,
        portalType,
        authenticatedAt: Date.now(),
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Set HTTP-only secure cookie
    const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
    const cookieOptions = [
      `cq_session=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${24 * 60 * 60}`, // 24 hours
    ];
    if (isProduction) {
      cookieOptions.push('Secure');
    }

    // User info cookie (readable by JS for display purposes)
    const userCookieOptions = [
      `cq_user=${encodeURIComponent(normalizedEmail)}`,
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${24 * 60 * 60}`,
    ];
    if (isProduction) {
      userCookieOptions.push('Secure');
    }

    res.setHeader('Set-Cookie', [
      cookieOptions.join('; '),
      userCookieOptions.join('; '),
    ]);

    return res.status(200).json({
      success: true,
      redirectUrl: PORTAL_URLS[portalType] || '/client',
    });
  } catch (error) {
    console.error('verify-otp error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

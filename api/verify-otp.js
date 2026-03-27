const jwt = require('jsonwebtoken');
const { kv: kvStore } = require('./_lib/kv-compat');
const { getOTP, incrementAttempts, deleteOTP } = require('./_lib/otp');
const { validateCSRFToken } = require('./_lib/csrf');

const JWT_SECRET = process.env.JWT_SECRET;

// Rate limiter for OTP verification: max 5 attempts per email per 10 minutes
const otpRateLimitMap = new Map();
function checkOTPRateLimit(email, maxAttempts = 5, windowMs = 600000) { // 10 minutes
  const now = Date.now();
  const windowStart = now - windowMs;
  let attempts = otpRateLimitMap.get(email) || [];
  attempts = attempts.filter(t => t > windowStart);

  if (attempts.length >= maxAttempts) {
    return false; // Rate limited
  }

  attempts.push(now);
  otpRateLimitMap.set(email, attempts);
  return true;
}

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not configured');
}
const SHAREPOINT_URL = process.env.SHAREPOINT_SITE_URL || 'https://cqadvocates.sharepoint.com/sites/CQClientPortal';

// Portal URLs on the main website (branded wrappers)
const PORTAL_URLS = {
  client: '/client',
  staff: '/staff',
};

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate CSRF token
  if (!validateCSRFToken(req)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  try {
    const { email, code, portalType } = req.body;

    if (!email || !code || !portalType) {
      return res.status(400).json({ error: 'Email, code, and portal type are required.' });
    }

    // Validate types
    if (typeof email !== 'string' || typeof code !== 'string' || typeof portalType !== 'string') {
      return res.status(400).json({ error: 'email, code, and portalType must be strings.' });
    }

    // Trim and validate non-empty
    const trimmedEmail = email.trim();
    const trimmedCode = code.trim();
    const trimmedPortalType = portalType.trim();

    if (!trimmedEmail || !trimmedCode || !trimmedPortalType) {
      return res.status(400).json({ error: 'Email, code, and portal type cannot be empty.' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (!['client', 'staff'].includes(trimmedPortalType)) {
      return res.status(400).json({ error: 'Invalid portal type.' });
    }

    const normalizedEmail = trimmedEmail.toLowerCase();

    // Initialize Vercel KV
    const kv = kvStore;

    // Retrieve stored OTP
    const otpData = await getOTP(kv, normalizedEmail);

    if (!otpData) {
      return res.status(400).json({
        error: 'Verification code has expired. Please request a new one.',
      });
    }

    // Apply rate limiting: max 5 attempts per 10 minutes
    if (!checkOTPRateLimit(normalizedEmail, 5, 600000)) {
      // Rate limited - invalidate OTP and require new one
      await deleteOTP(kv, normalizedEmail);
      return res.status(429).json({
        error: 'Too many verification attempts. Please request a new code.',
      });
    }

    // Check max attempts (5 per the rate limiter, but also check stored attempts as backup)
    if (otpData.attempts >= 5) {
      await deleteOTP(kv, normalizedEmail);
      return res.status(400).json({
        error: 'Too many failed attempts. Please request a new code.',
      });
    }

    // Verify code
    if (otpData.code !== trimmedCode) {
      await incrementAttempts(kv, normalizedEmail);
      // Generic error message - don't reveal remaining attempts
      return res.status(400).json({
        error: 'Invalid verification code. Please try again or request a new code.',
      });
    }

    // OTP is correct - clean up
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
    const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Production' || process.env.WEBSITE_SITE_NAME;
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
    // NOTE: Do NOT use encodeURIComponent here — Azure Functions' cookie handler
    // will re-encode the value, causing double-encoding (%40 → %2540).
    // The @ character is valid in cookie values per RFC 6265.
    const userCookieOptions = [
      `cq_user=${normalizedEmail}`,
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

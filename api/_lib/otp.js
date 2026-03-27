const crypto = require('crypto');

/**
 * Stateless HMAC-based OTP system.
 *
 * Instead of storing OTPs in memory (which is lost on Azure Functions cold start),
 * we cryptographically sign the OTP data and return a token to the client.
 * The client sends the token back during verification, and we verify the signature.
 *
 * This eliminates all server-side state for OTP storage.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Create an HMAC signature for OTP data
 */
function createOTPSignature(email, code, expiresAt) {
  const payload = `${email.toLowerCase()}:${code}:${expiresAt}`;
  return crypto.createHmac('sha256', OTP_SECRET).update(payload).digest('hex');
}

/**
 * Create a signed OTP token that the client stores and sends back during verification.
 * The token contains: expiry timestamp + HMAC signature (but NOT the code itself).
 */
function createOTPToken(email, code) {
  const expiresAt = Date.now() + OTP_TTL_MS;
  const signature = createOTPSignature(email, code, expiresAt);

  // Encode as base64 JSON for easy transport
  const tokenData = JSON.stringify({ exp: expiresAt, sig: signature });
  return Buffer.from(tokenData).toString('base64');
}

/**
 * Verify an OTP code against a signed token.
 * Returns: { valid: true } or { valid: false, reason: string }
 */
function verifyOTPToken(email, code, token) {
  try {
    const tokenData = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    const { exp, sig } = tokenData;

    if (!exp || !sig) {
      return { valid: false, reason: 'Invalid verification token.' };
    }

    // Check expiry
    if (Date.now() > exp) {
      return { valid: false, reason: 'Verification code has expired. Please request a new one.' };
    }

    // Recompute HMAC with the provided code and compare
    const expectedSig = createOTPSignature(email, code, exp);
    const isValid = crypto.timingSafeEqual(
      Buffer.from(sig, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );

    if (!isValid) {
      return { valid: false, reason: 'Invalid verification code. Please try again or request a new code.' };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, reason: 'Invalid verification token. Please request a new code.' };
  }
}

// ---- Legacy KV-based functions (kept for backward compatibility but no longer primary) ----

async function storeOTP(kv, email, otp) {
  const key = `otp:${email.toLowerCase()}`;
  const data = { code: otp, attempts: 0, createdAt: Date.now() };
  await kv.set(key, JSON.stringify(data), { ex: 600 });
}

async function getOTP(kv, email) {
  const key = `otp:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function incrementAttempts(kv, email) {
  const key = `otp:${email.toLowerCase()}`;
  const data = await getOTP(kv, email);
  if (!data) return;
  data.attempts += 1;
  const ttl = await kv.ttl(key);
  if (ttl > 0) {
    await kv.set(key, JSON.stringify(data), { ex: ttl });
  }
}

async function deleteOTP(kv, email) {
  const key = `otp:${email.toLowerCase()}`;
  await kv.del(key);
}

async function checkRateLimit(kv, email) {
  const key = `rate:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  const count = raw ? (typeof raw === 'string' ? parseInt(raw) : raw) : 0;
  if (count >= 5) return false;
  if (count === 0) {
    await kv.set(key, 1, { ex: 3600 });
  } else {
    const ttl = await kv.ttl(key);
    await kv.set(key, count + 1, { ex: ttl > 0 ? ttl : 3600 });
  }
  return true;
}

module.exports = {
  generateOTP,
  createOTPToken,
  verifyOTPToken,
  storeOTP,
  getOTP,
  incrementAttempts,
  deleteOTP,
  checkRateLimit,
};

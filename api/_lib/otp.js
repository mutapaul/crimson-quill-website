const crypto = require('crypto');

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Store OTP in Vercel KV with TTL
 * @param {object} kv - Vercel KV instance
 * @param {string} email - User email
 * @param {string} otp - The 6-digit code
 */
async function storeOTP(kv, email, otp) {
  const key = `otp:${email.toLowerCase()}`;
  const data = {
    code: otp,
    attempts: 0,
    createdAt: Date.now(),
  };
  // Store with 10-minute TTL (600 seconds)
  await kv.set(key, JSON.stringify(data), { ex: 600 });
}

/**
 * Retrieve stored OTP data
 */
async function getOTP(kv, email) {
  const key = `otp:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Increment attempt count
 */
async function incrementAttempts(kv, email) {
  const key = `otp:${email.toLowerCase()}`;
  const data = await getOTP(kv, email);
  if (!data) return;
  data.attempts += 1;
  // Keep existing TTL by getting remaining TTL
  const ttl = await kv.ttl(key);
  if (ttl > 0) {
    await kv.set(key, JSON.stringify(data), { ex: ttl });
  }
}

/**
 * Delete OTP after successful verification
 */
async function deleteOTP(kv, email) {
  const key = `otp:${email.toLowerCase()}`;
  await kv.del(key);
}

/**
 * Rate limiting: check if email has exceeded OTP request limit
 * Max 5 requests per email per hour
 */
async function checkRateLimit(kv, email) {
  const key = `rate:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  const count = raw ? (typeof raw === 'string' ? parseInt(raw) : raw) : 0;

  if (count >= 5) {
    return false; // Rate limited
  }

  // Increment and set 1-hour TTL if first request
  if (count === 0) {
    await kv.set(key, 1, { ex: 3600 });
  } else {
    const ttl = await kv.ttl(key);
    await kv.set(key, count + 1, { ex: ttl > 0 ? ttl : 3600 });
  }

  return true;
}

module.exports = { generateOTP, storeOTP, getOTP, incrementAttempts, deleteOTP, checkRateLimit };

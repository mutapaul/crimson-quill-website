/**
 * Rate Limiting Utility using Vercel KV
 * Works across serverless cold starts with persistent storage
 */

async function checkRateLimit(kv, key, maxRequests, windowSeconds) {
  try {
    // Get current count
    const raw = await kv.get(key);
    const current = raw ? (typeof raw === 'string' ? parseInt(raw) : raw) : 0;

    // Check if limit exceeded
    if (current >= maxRequests) {
      return false;
    }

    // Increment count
    if (current === 0) {
      // First request in window - set expiry
      await kv.set(key, 1, { ex: windowSeconds });
    } else {
      // Subsequent request - increment
      const ttl = await kv.ttl(key);
      await kv.set(key, current + 1, { ex: ttl > 0 ? ttl : windowSeconds });
    }

    return true;
  } catch (error) {
    console.error('Rate limit check error:', error);
    // On KV error, allow the request (fail open)
    return true;
  }
}

module.exports = {
  checkRateLimit,
};

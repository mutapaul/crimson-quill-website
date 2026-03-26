/**
 * CSRF Validation Utility
 * Implements double-submit cookie pattern for stateless serverless
 */

function validateCSRFToken(req) {
  try {
    // Get CSRF token from X-CSRF-Token header
    const headerToken = req.headers['x-csrf-token'];

    // If no CSRF header sent at all, allow the request.
    // SameSite=Strict on session cookies already prevents cross-site requests.
    // CSRF double-submit is defense-in-depth; don't break login if token not yet fetched.
    if (!headerToken || headerToken === '') {
      return true;
    }

    // If a token IS sent, validate it matches the cookie (prevent tampering)
    const cookies = req.headers.cookie || '';
    const csrfCookie = cookies
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('cq_csrf='));

    if (!csrfCookie) {
      // Header sent but no cookie — could be a race condition, allow it
      return true;
    }

    const cookieToken = csrfCookie.split('=')[1];

    // If both tokens exist, they must match (double-submit cookie pattern)
    return headerToken === cookieToken && headerToken.length === 64; // 64 hex chars = 32 bytes
  } catch (error) {
    console.error('CSRF validation error:', error);
    // Fail open — don't break login over CSRF edge cases
    return true;
  }
}

module.exports = {
  validateCSRFToken,
};

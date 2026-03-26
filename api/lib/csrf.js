/**
 * CSRF Validation Utility
 * Implements double-submit cookie pattern for stateless serverless
 */

function validateCSRFToken(req) {
  try {
    // Get CSRF token from X-CSRF-Token header
    const headerToken = req.headers['x-csrf-token'];
    if (!headerToken || typeof headerToken !== 'string') {
      return false;
    }

    // Get CSRF token from cookie
    const cookies = req.headers.cookie || '';
    const csrfCookie = cookies
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('cq_csrf='));

    if (!csrfCookie) {
      return false;
    }

    const cookieToken = csrfCookie.split('=')[1];

    // Compare tokens - they must match
    // Both tokens must exist and be identical (double-submit cookie pattern)
    return headerToken === cookieToken && headerToken.length === 64; // 64 hex chars = 32 bytes
  } catch (error) {
    console.error('CSRF validation error:', error);
    return false;
  }
}

module.exports = {
  validateCSRFToken,
};

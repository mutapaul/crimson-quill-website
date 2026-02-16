const { Resend } = require('resend');
const { createClient } = require('@vercel/kv');
const jwt = require('jsonwebtoken');

const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Check rate limit for email notifications
 * Max 10 emails per hour per email address
 */
async function checkEmailRateLimit(kv, email) {
  const key = `notify_rate:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  const count = raw ? (typeof raw === 'string' ? parseInt(raw) : raw) : 0;

  if (count >= 10) {
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

/**
 * Validate session cookie
 */
function validateSession(req) {
  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('cq_session='));

    if (!sessionCookie) {
      return null;
    }

    const token = sessionCookie.split('=')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    return decoded;
  } catch (error) {
    return null;
  }
}

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

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Validate session
    const session = validateSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized. Please login to send notifications.' });
    }

    // Ensure user is staff (portal type is 'staff')
    if (session.portalType !== 'staff') {
      return res.status(403).json({ error: 'Forbidden. Only staff members can send notifications.' });
    }

    const { email, clientName, portalType, staffRole } = req.body;

    // Validate input
    if (!email || !clientName || !portalType) {
      return res.status(400).json({ error: 'Email, name, and portal type are required.' });
    }

    if (portalType !== 'welcome' && portalType !== 'staff-invite') {
      return res.status(400).json({ error: 'Invalid portal type.' });
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Initialize Vercel KV
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // Check rate limit
    const allowed = await checkEmailRateLimit(kv, normalizedEmail);
    if (!allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Maximum 10 emails per hour per email address.',
      });
    }

    // Build email content based on portal type
    let emailSubject, emailHtml;

    if (portalType === 'staff-invite') {
      const role = staffRole || 'Team Member';
      emailSubject = 'You Have Been Added to the Crimson & Quill Staff Portal';
      emailHtml = `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background: #FAFAFA;">
          <!-- Header -->
          <div style="background: #000000; padding: 40px 30px; text-align: center;">
            <span style="font-family: Georgia, serif; font-size: 28px; font-weight: 600; color: #FFFFFF;">
              Crimson <span style="color: #B8860B; font-style: italic;">&</span> Quill
            </span>
            <div style="margin-top: 8px;">
              <span style="display: inline-block; background: #B8860B; color: #FFFFFF; padding: 4px 14px; border-radius: 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase;">Staff Portal</span>
            </div>
          </div>

          <!-- Main Content -->
          <div style="padding: 40px 30px; background: #FFFFFF;">
            <p style="font-size: 16px; color: #000000; line-height: 1.6; margin: 0 0 24px;">
              Dear <strong>${clientName}</strong>,
            </p>

            <p style="font-size: 15px; color: #333333; line-height: 1.6; margin: 0 0 24px;">
              You have been added to the <strong>Crimson & Quill Staff Portal</strong> as <strong>${role}</strong>. The portal is your central hub for managing client matters, documents, communications, billing, and firm operations.
            </p>

            <!-- CTA Button -->
            <div style="text-align: center; margin: 32px 0;">
              <a href="https://www.cqadvocates.com/login?type=staff" style="display: inline-block; background: #B8860B; color: #FFFFFF; padding: 14px 40px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
                Access Staff Portal
              </a>
            </div>

            <div style="border-left: 3px solid #B8860B; padding-left: 20px; margin: 32px 0; background: #F5F5F5; padding: 16px 20px;">
              <h3 style="font-size: 14px; font-weight: 600; color: #000000; margin: 0 0 12px;">How to Login</h3>
              <ol style="font-size: 13px; color: #555555; line-height: 1.8; margin: 0; padding-left: 20px;">
                <li>Click the <strong>Access Staff Portal</strong> button above</li>
                <li>Enter your email address (<strong>${normalizedEmail}</strong>)</li>
                <li>You will receive a secure one-time verification code</li>
                <li>Enter the code to access the staff portal</li>
              </ol>
            </div>

            <h3 style="font-size: 14px; font-weight: 600; color: #000000; margin: 24px 0 12px;">Your Role: ${role}</h3>
            <p style="font-size: 13px; color: #555555; line-height: 1.6; margin: 0 0 16px;">
              As a member of the Crimson & Quill team, you have access to:
            </p>
            <ul style="font-size: 13px; color: #555555; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Manage client matters and case files</li>
              <li>Upload, organise, and share legal documents</li>
              <li>Communicate with clients through secure messaging</li>
              <li>Create and send invoices</li>
              <li>Schedule events and manage the firm calendar</li>
              <li>View reports and firm analytics</li>
            </ul>

            <p style="font-size: 13px; color: #777777; line-height: 1.6; margin: 24px 0 0;">
              If you have any questions about your access or need support, please contact the firm administrator.
            </p>
          </div>

          <!-- Footer -->
          <div style="border-top: 1px solid #E0E0E0; padding: 24px 30px; background: #FAFAFA; text-align: center;">
            <p style="font-size: 12px; color: #999999; margin: 0 0 8px;">
              <strong>Crimson & Quill</strong>
            </p>
            <p style="font-size: 11px; color: #AAAAAA; margin: 0;">
              Kampala, Uganda<br/>
              Professional Legal Services
            </p>
          </div>
        </div>
      `;
    } else {
      // Client welcome email
      emailSubject = 'Welcome to the Crimson & Quill Client Portal';
      emailHtml = `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background: #FAFAFA;">
          <!-- Header -->
          <div style="background: #000000; padding: 40px 30px; text-align: center;">
            <span style="font-family: Georgia, serif; font-size: 28px; font-weight: 600; color: #FFFFFF;">
              Crimson <span style="color: #B8860B; font-style: italic;">&</span> Quill
            </span>
          </div>

          <!-- Main Content -->
          <div style="padding: 40px 30px; background: #FFFFFF;">
            <p style="font-size: 16px; color: #000000; line-height: 1.6; margin: 0 0 24px;">
              Welcome, <strong>${clientName}</strong>!
            </p>

            <p style="font-size: 15px; color: #333333; line-height: 1.6; margin: 0 0 24px;">
              We're excited to welcome you to the Crimson & Quill Client Portal. Your dedicated legal team is here to support you, and this portal gives you direct access to your matters, documents, invoices, and more.
            </p>

            <!-- CTA Button -->
            <div style="text-align: center; margin: 32px 0;">
              <a href="https://www.cqadvocates.com/login?type=client" style="display: inline-block; background: #B8860B; color: #FFFFFF; padding: 14px 40px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
                Access Your Portal
              </a>
            </div>

            <div style="border-left: 3px solid #B8860B; padding-left: 20px; margin: 32px 0; background: #F5F5F5; padding: 16px 20px;">
              <h3 style="font-size: 14px; font-weight: 600; color: #000000; margin: 0 0 12px;">How to Login</h3>
              <ol style="font-size: 13px; color: #555555; line-height: 1.8; margin: 0; padding-left: 20px;">
                <li>Visit the portal login page using the button above</li>
                <li>Enter your email address (<strong>${normalizedEmail}</strong>)</li>
                <li>We'll send you a secure verification code</li>
                <li>Enter the code to access your portal</li>
              </ol>
            </div>

            <h3 style="font-size: 14px; font-weight: 600; color: #000000; margin: 24px 0 12px;">What You Can Access</h3>
            <ul style="font-size: 13px; color: #555555; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>View your active matters and case details</li>
              <li>Download documents and correspondence</li>
              <li>Review invoices and billing information</li>
              <li>Check important dates and calendar events</li>
              <li>Send secure messages to your legal team</li>
            </ul>

            <p style="font-size: 13px; color: #777777; line-height: 1.6; margin: 24px 0 0;">
              If you have any questions or need assistance, please don't hesitate to reach out to us directly. We're here to help.
            </p>
          </div>

          <!-- Footer -->
          <div style="border-top: 1px solid #E0E0E0; padding: 24px 30px; background: #FAFAFA; text-align: center;">
            <p style="font-size: 12px; color: #999999; margin: 0 0 8px;">
              <strong>Crimson & Quill</strong>
            </p>
            <p style="font-size: 11px; color: #AAAAAA; margin: 0;">
              Kampala, Uganda<br/>
              Professional Legal Services
            </p>
          </div>
        </div>
      `;
    }

    // Send email via Resend
    const { error: sendError } = await resend.emails.send({
      from: 'Crimson & Quill <portal@cqadvocates.com>',
      to: [normalizedEmail],
      subject: emailSubject,
      html: emailHtml,
    });

    if (sendError) {
      console.error('Resend error:', sendError);
      return res.status(500).json({ error: 'Failed to send email. Please try again.' });
    }

    return res.status(200).json({
      success: true,
      message: `${portalType === 'staff-invite' ? 'Staff invite' : 'Welcome'} email sent to ${normalizedEmail}`,
    });
  } catch (error) {
    console.error('notify-client error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

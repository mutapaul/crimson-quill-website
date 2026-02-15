const { Resend } = require('resend');
const { createClient } = require('@vercel/kv');
const { isEmailInGroup, isFirmEmail } = require('./lib/graph');
const { generateOTP, storeOTP, checkRateLimit } = require('./lib/otp');

const resend = new Resend(process.env.RESEND_API_KEY);

// SharePoint security group IDs
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID || '';
const CLIENT_GROUP_ID = process.env.CLIENT_GROUP_ID || '';

module.exports = async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, portalType } = req.body;

    // Validate input
    if (!email || !portalType) {
      return res.status(400).json({ error: 'Email and portal type are required.' });
    }

    if (!['client', 'staff'].includes(portalType)) {
      return res.status(400).json({ error: 'Invalid portal type.' });
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Initialize Vercel KV
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // Check rate limit
    const allowed = await checkRateLimit(kv, normalizedEmail);
    if (!allowed) {
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
      });
    }

    // Check portal access based on type
    let hasAccess = false;

    if (portalType === 'staff') {
      // Staff must be @cqadvocates.com domain users
      if (!isFirmEmail(normalizedEmail)) {
        return res.status(403).json({
          error: 'Staff portal access is restricted to Crimson & Quill team members.',
        });
      }
      // Optionally check if in staff security group
      if (STAFF_GROUP_ID) {
        hasAccess = await isEmailInGroup(normalizedEmail, STAFF_GROUP_ID);
      } else {
        // If no group ID configured, allow all @cqadvocates.com emails
        hasAccess = true;
      }
    } else {
      // Client portal - check if email is in client security group
      if (CLIENT_GROUP_ID) {
        hasAccess = await isEmailInGroup(normalizedEmail, CLIENT_GROUP_ID);
      } else {
        // Fallback: also check if it's a firm email (staff can access client portal too)
        hasAccess = isFirmEmail(normalizedEmail);
      }
    }

    if (!hasAccess) {
      return res.status(403).json({
        error: 'No account found for this email address. Please contact your legal team if you believe this is an error.',
      });
    }

    // Generate and store OTP
    const otp = generateOTP();
    await storeOTP(kv, normalizedEmail, otp);

    // Send OTP via Resend
    const { error: sendError } = await resend.emails.send({
      from: 'Crimson & Quill Portal <portal@cqadvocates.com>',
      to: [normalizedEmail],
      subject: `${otp} - Your Crimson & Quill Verification Code`,
      html: `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 30px; background: #FAFAFA;">
          <div style="text-align: center; margin-bottom: 32px;">
            <span style="font-family: Georgia, serif; font-size: 22px; font-weight: 600; color: #000000;">
              Crimson <span style="color: #B8860B; font-style: italic;">&</span> Quill
            </span>
          </div>

          <div style="border-top: 2px solid #B8860B; padding-top: 24px;">
            <p style="font-size: 15px; color: #333333; line-height: 1.6; margin: 0 0 20px;">
              Your verification code for the ${portalType === 'staff' ? 'Staff' : 'Client'} Portal is:
            </p>

            <div style="text-align: center; margin: 24px 0;">
              <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #000000; background: #FAFAFA; padding: 16px 32px; border-radius: 8px; display: inline-block;">
                ${otp}
              </span>
            </div>

            <p style="font-size: 13px; color: #888888; line-height: 1.5; margin: 20px 0 0;">
              This code expires in 10 minutes. If you did not request this code, please ignore this email.
            </p>
          </div>

          <div style="border-top: 1px solid #E0E0E0; margin-top: 32px; padding-top: 16px; text-align: center;">
            <p style="font-size: 11px; color: #AAAAAA; margin: 0;">
              Crimson & Quill &bull; Kampala, Uganda
            </p>
          </div>
        </div>
      `,
    });

    if (sendError) {
      console.error('Resend error:', sendError);
      return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Verification code sent to your email.',
    });
  } catch (error) {
    console.error('request-otp error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

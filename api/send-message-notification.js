const { Resend } = require('resend');
const { kv: kvStore } = require('./_lib/kv-compat');
const jwt = require('jsonwebtoken');

const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Rate limit: max 30 message notification emails per hour per recipient
 */
async function checkRateLimit(kv, email) {
  const key = `msg_notify_rate:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  const count = raw ? (typeof raw === 'string' ? parseInt(raw) : raw) : 0;

  if (count >= 30) {
    return false;
  }

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

    if (!sessionCookie) return null;

    const token = sessionCookie.split('=')[1];
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Build the notification email HTML
 */
function buildEmailHtml({ senderName, senderType, matterId, messagePreview, portalUrl }) {
  const accentColor = '#B8860B';
  const preview = (messagePreview || '').substring(0, 300);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Inter,Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#0D0D0D;padding:24px 32px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
        Crimson <span style="color:${accentColor};">&amp;</span> Quill
      </div>
      <div style="font-size:11px;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:1px;">Chambers</div>
    </div>

    <!-- Body -->
    <div style="padding:32px;">
      <div style="font-size:16px;font-weight:600;color:#0D0D0D;margin-bottom:16px;">
        New Message in ${matterId ? 'Matter: ' + matterId : 'your conversation'}
      </div>

      <div style="font-size:14px;color:#4A4A4A;line-height:1.6;margin-bottom:20px;">
        <strong>${senderName || 'Someone'}</strong> (${senderType === 'client' ? 'Client' : 'Crimson &amp; Quill Staff'}) sent you a message:
      </div>

      <!-- Message preview card -->
      <div style="background:#FAFAFA;border-left:4px solid ${accentColor};border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap;">${preview}${messagePreview && messagePreview.length > 300 ? '...' : ''}</div>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin:28px 0;">
        <a href="${portalUrl}" style="display:inline-block;background:${accentColor};color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:0.3px;">
          View &amp; Reply
        </a>
      </div>

      <div style="font-size:12px;color:#999;text-align:center;line-height:1.5;">
        You received this because you are part of a conversation in the<br>Crimson &amp; Quill Client Portal.
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#FAFAFA;padding:16px 32px;text-align:center;border-top:1px solid #eee;">
      <div style="font-size:11px;color:#999;">
        Crimson &amp; Quill Chambers &middot; Kampala, Uganda<br>
        &copy; ${new Date().getFullYear()} All rights reserved
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Validate session — any authenticated user can trigger notifications
    const session = validateSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      recipients,       // Array of email addresses to notify
      senderName,       // Display name of sender
      senderEmail,      // Email of the sender (to exclude from recipients)
      senderType,       // 'staff' or 'client'
      matterId,         // Matter reference for context
      messagePreview,   // First part of the message body
    } = req.body || {};

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients array is required' });
    }

    if (!messagePreview) {
      return res.status(400).json({ error: 'messagePreview is required' });
    }

    const kv = kvStore;
    const portalBaseUrl = 'https://www.cqadvocates.com';
    const results = [];

    for (const recipientEmail of recipients) {
      // Don't notify the sender
      if (senderEmail && recipientEmail.toLowerCase() === senderEmail.toLowerCase()) {
        results.push({ email: recipientEmail, status: 'skipped', reason: 'sender' });
        continue;
      }

      // Rate limit check
      const allowed = await checkRateLimit(kv, recipientEmail);
      if (!allowed) {
        results.push({ email: recipientEmail, status: 'skipped', reason: 'rate_limited' });
        continue;
      }

      // Determine which portal to link to
      const isStaffRecipient = recipientEmail.toLowerCase().endsWith('@cqadvocates.com');
      const portalUrl = isStaffRecipient
        ? `${portalBaseUrl}/staff#messages`
        : `${portalBaseUrl}/client#messages`;

      const html = buildEmailHtml({
        senderName: senderName || senderEmail || 'A user',
        senderType: senderType || 'staff',
        matterId,
        messagePreview,
        portalUrl,
      });

      try {
        await resend.emails.send({
          from: 'Crimson & Quill <portal@cqadvocates.com>',
          to: [recipientEmail],
          subject: `New message${matterId ? ' in ' + matterId : ''} — Crimson & Quill`,
          html,
        });
        results.push({ email: recipientEmail, status: 'sent' });
      } catch (emailError) {
        console.error(`Failed to send notification to ${recipientEmail}:`, emailError);
        results.push({ email: recipientEmail, status: 'failed', error: emailError.message });
      }
    }

    return res.status(200).json({ success: true, results });

  } catch (error) {
    console.error('Message notification error:', error);
    return res.status(500).json({ error: 'Failed to send notifications' });
  }
};

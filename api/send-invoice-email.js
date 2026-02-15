const { Resend } = require('resend');
const jwt = require('jsonwebtoken');

const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

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

/**
 * Format currency amount
 */
function formatCurrency(amount, currency) {
  const currencySymbols = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    UGX: 'USh',
  };

  const symbol = currencySymbols[currency] || currency;
  const formatted = parseFloat(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return `${symbol}${formatted}`;
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
      return res.status(401).json({ error: 'Unauthorized. Please login to send invoices.' });
    }

    // Ensure user is staff (portal type is 'staff')
    if (session.portalType !== 'staff') {
      return res.status(403).json({ error: 'Forbidden. Only staff members can send invoices.' });
    }

    const {
      email,
      clientName,
      invoiceNumber,
      matterReference,
      totalAmount,
      currency,
      dueDate,
      invoiceHtml,
    } = req.body;

    // Validate input
    if (!email || !clientName || !invoiceNumber || !matterReference || !totalAmount || !currency || !dueDate) {
      return res.status(400).json({
        error: 'Missing required fields: email, clientName, invoiceNumber, matterReference, totalAmount, currency, dueDate.',
      });
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const formattedAmount = formatCurrency(totalAmount, currency);

    // Parse due date
    let dueDateFormatted = dueDate;
    try {
      const dueDateObj = new Date(dueDate);
      dueDateFormatted = dueDateObj.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch (e) {
      // If date parsing fails, use the raw value
    }

    // Build email HTML
    const emailContent = `
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
            Hello <strong>${clientName}</strong>,
          </p>

          <p style="font-size: 15px; color: #333333; line-height: 1.6; margin: 0 0 28px;">
            Please find your invoice attached. A summary of the invoice details is shown below.
          </p>

          <!-- Invoice Summary Box -->
          <div style="border: 2px solid #B8860B; border-radius: 8px; padding: 24px; margin: 32px 0; background: #FAFAFA;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr style="border-bottom: 1px solid #E0E0E0;">
                <td style="padding: 12px 0; color: #666666;">Invoice Number</td>
                <td style="padding: 12px 0; color: #000000; font-weight: 600; text-align: right;">${invoiceNumber}</td>
              </tr>
              <tr style="border-bottom: 1px solid #E0E0E0;">
                <td style="padding: 12px 0; color: #666666;">Matter Reference</td>
                <td style="padding: 12px 0; color: #000000; font-weight: 500; text-align: right;">${matterReference}</td>
              </tr>
              <tr style="border-bottom: 1px solid #E0E0E0;">
                <td style="padding: 12px 0; color: #666666;">Amount Due</td>
                <td style="padding: 12px 0; color: #000000; font-weight: 600; font-size: 16px; text-align: right;">${formattedAmount}</td>
              </tr>
              <tr>
                <td style="padding: 12px 0; color: #666666;">Due Date</td>
                <td style="padding: 12px 0; color: #000000; font-weight: 600; text-align: right;">${dueDateFormatted}</td>
              </tr>
            </table>
          </div>

          <!-- Payment Instructions -->
          <div style="background: #F5F5F5; border-left: 3px solid #B8860B; padding: 16px 20px; margin: 24px 0;">
            <h3 style="font-size: 13px; font-weight: 600; color: #000000; margin: 0 0 12px;">Payment Instructions</h3>
            <p style="font-size: 13px; color: #555555; line-height: 1.6; margin: 0;">
              Please make payment by the due date to the account details provided in your full invoice. If you have any questions about this invoice or need alternative payment arrangements, please contact us.
            </p>
          </div>

          <!-- Invoice Document -->
          ${invoiceHtml ? `
          <div style="border: 1px solid #E0E0E0; border-radius: 8px; padding: 24px; margin: 32px 0; background: #FFFFFF;">
            <h3 style="font-size: 13px; font-weight: 600; color: #000000; margin: 0 0 16px; text-align: center;">Full Invoice</h3>
            ${invoiceHtml}
          </div>
          ` : ''}

          <!-- CTA Button -->
          <div style="text-align: center; margin: 32px 0;">
            <a href="https://www.cqadvocates.com/login?type=client" style="display: inline-block; background: #B8860B; color: #FFFFFF; padding: 14px 40px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
              View in Client Portal
            </a>
          </div>

          <p style="font-size: 13px; color: #777777; line-height: 1.6; margin: 24px 0 0;">
            If you have any questions regarding this invoice or your matter, please don't hesitate to reach out to your legal team. We're here to assist you.
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

    // Send invoice email via Resend
    const { error: sendError } = await resend.emails.send({
      from: 'Crimson & Quill <portal@cqadvocates.com>',
      to: [normalizedEmail],
      subject: `Invoice ${invoiceNumber} - Crimson & Quill`,
      html: emailContent,
    });

    if (sendError) {
      console.error('Resend error:', sendError);
      return res.status(500).json({ error: 'Failed to send invoice email. Please try again.' });
    }

    return res.status(200).json({
      success: true,
      message: `Invoice email sent to ${normalizedEmail}`,
      invoiceNumber: invoiceNumber,
    });
  } catch (error) {
    console.error('send-invoice-email error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

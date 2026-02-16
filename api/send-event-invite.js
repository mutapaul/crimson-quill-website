const { Resend } = require('resend');
const { createClient } = require('@vercel/kv');
const jwt = require('jsonwebtoken');

const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

// In-memory token cache for Graph API
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = {};
let listIdCache = {};

const SITE_PATHS = {
  client: 'cqadvocates.sharepoint.com:/sites/CQClientPortal',
};

/**
 * Check rate limit for event invite emails
 * Max 20 event invites per hour per sender email
 */
async function checkEventInviteRateLimit(kv, email) {
  const key = `event_invite_rate:${email.toLowerCase()}`;
  const raw = await kv.get(key);
  const count = raw ? (typeof raw === 'string' ? parseInt(raw) : raw) : 0;

  if (count >= 20) {
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

/**
 * Get access token from Azure AD using client_credentials
 */
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token request failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in * 1000) - 300000; // 5min buffer
  return data.access_token;
}

/**
 * Call Microsoft Graph API
 */
async function graphApi(path, token, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, options);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Graph API error (${resp.status}): ${errText}`);
  }

  if (resp.status === 204) {
    return { success: true };
  }

  return resp.json();
}

/**
 * Create Teams online meeting
 */
async function createTeamsMeeting(organizerEmail, eventTitle, eventDate, eventDuration) {
  try {
    const token = await getAccessToken();

    // Parse the ISO datetime
    const startTime = new Date(eventDate);
    const endTime = new Date(startTime.getTime() + eventDuration * 60000);

    const meetingBody = {
      startDateTime: startTime.toISOString(),
      endDateTime: endTime.toISOString(),
      subject: eventTitle,
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    };

    const result = await graphApi(
      `/users/${organizerEmail}/onlineMeetings`,
      token,
      'POST',
      meetingBody
    );

    return result.joinWebUrl || null;
  } catch (error) {
    // Gracefully skip Teams meeting creation if permissions are missing
    console.error(`Teams meeting creation failed for ${organizerEmail}:`, error.message);
    return null;
  }
}

/**
 * Resolve SharePoint site ID
 */
async function getSiteId(siteKey) {
  if (siteIdCache[siteKey] && Date.now() < (siteIdCache._exp || 0)) {
    return siteIdCache[siteKey];
  }
  const token = await getAccessToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${SITE_PATHS[siteKey]}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to get site ID (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  siteIdCache[siteKey] = data.id;
  siteIdCache._exp = Date.now() + 86400000; // 24h
  return data.id;
}

/**
 * Resolve list ID by name
 */
async function getListId(siteId, listName, token, cacheKey) {
  if (listIdCache[cacheKey] && Date.now() < (listIdCache._exp || 0)) {
    return listIdCache[cacheKey];
  }

  const listsResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!listsResp.ok) {
    const errText = await listsResp.text();
    throw new Error(`Failed to get lists (${listsResp.status}): ${errText}`);
  }

  const listsData = await listsResp.json();
  const targetList = listsData.value.find(
    (l) => l.displayName === listName || l.displayName.toLowerCase() === listName.toLowerCase()
  );

  if (!targetList) {
    throw new Error(`List '${listName}' not found`);
  }

  listIdCache[cacheKey] = targetList.id;
  listIdCache._exp = Date.now() + 86400000; // 24h
  return targetList.id;
}

/**
 * Update SharePoint list item with Teams link
 */
async function updateSharePointItem(siteId, listId, itemId, teamsLink) {
  try {
    const token = await getAccessToken();

    const fields = {
      Teams_x0020_Link: teamsLink,
    };

    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${itemId}/fields`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fields),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to update item (${resp.status}): ${errText}`);
    }

    return true;
  } catch (error) {
    console.error(`SharePoint update failed for item ${itemId}:`, error.message);
    throw error;
  }
}

/**
 * Format date for display
 */
function formatEventDate(isoDateTime) {
  const date = new Date(isoDateTime);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/**
 * Build event invite email HTML
 */
function buildEventInviteEmail(
  eventTitle,
  eventDate,
  location,
  description,
  matterReference,
  attendeeName,
  teamsLink,
  portalUrl = 'https://www.cqadvocates.com'
) {
  const formattedDate = formatEventDate(eventDate);

  let eventDetailsHtml = `
    <div style="border: 2px solid #B8860B; border-radius: 8px; padding: 24px; margin: 24px 0; background: #FAFAFA;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr style="border-bottom: 1px solid #E0E0E0;">
          <td style="padding: 12px 0; color: #666666; font-weight: 500;">Event</td>
          <td style="padding: 12px 0; color: #000000; font-weight: 600; text-align: right;">${eventTitle}</td>
        </tr>
        <tr style="border-bottom: 1px solid #E0E0E0;">
          <td style="padding: 12px 0; color: #666666; font-weight: 500;">Date & Time</td>
          <td style="padding: 12px 0; color: #000000; text-align: right;">${formattedDate}</td>
        </tr>
        <tr style="border-bottom: 1px solid #E0E0E0;">
          <td style="padding: 12px 0; color: #666666; font-weight: 500;">Location</td>
          <td style="padding: 12px 0; color: #000000; text-align: right;">${location}</td>
        </tr>
        <tr style="border-bottom: 1px solid #E0E0E0;">
          <td style="padding: 12px 0; color: #666666; font-weight: 500;">Matter</td>
          <td style="padding: 12px 0; color: #000000; text-align: right;">${matterReference}</td>
        </tr>
      </table>
    </div>
  `;

  if (teamsLink) {
    eventDetailsHtml += `
      <div style="background: #E8F4F8; border-left: 4px solid #0078D4; padding: 16px 20px; margin: 24px 0; border-radius: 4px;">
        <h3 style="font-size: 13px; font-weight: 600; color: #000000; margin: 0 0 12px;">Join via Microsoft Teams</h3>
        <p style="font-size: 13px; color: #555555; line-height: 1.6; margin: 0 0 12px;">
          This is an online meeting. Click the button below to join the Teams meeting.
        </p>
        <div style="text-align: center;">
          <a href="${teamsLink}" style="display: inline-block; background: #0078D4; color: #FFFFFF; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
            Join Teams Meeting
          </a>
        </div>
      </div>
    `;
  }

  return `
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
          Hello <strong>${attendeeName}</strong>,
        </p>

        <p style="font-size: 15px; color: #333333; line-height: 1.6; margin: 0 0 24px;">
          You are invited to an event related to your legal matter. Please see the details below.
        </p>

        <!-- Event Details -->
        ${eventDetailsHtml}

        <!-- Description -->
        ${description ? `
        <div style="background: #F5F5F5; padding: 16px 20px; border-radius: 4px; margin: 24px 0;">
          <h3 style="font-size: 13px; font-weight: 600; color: #000000; margin: 0 0 12px;">Event Description</h3>
          <p style="font-size: 13px; color: #555555; line-height: 1.6; margin: 0;">
            ${description}
          </p>
        </div>
        ` : ''}

        <!-- CTA Button -->
        <div style="text-align: center; margin: 32px 0;">
          <a href="${portalUrl}/login?type=client" style="display: inline-block; background: #B8860B; color: #FFFFFF; padding: 14px 40px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
            View in Client Portal
          </a>
        </div>

        <p style="font-size: 13px; color: #777777; line-height: 1.6; margin: 24px 0 0;">
          If you have any questions about this event or your matter, please don't hesitate to reach out to your legal team. We're here to assist you.
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

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Main handler
 */
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
      return res.status(401).json({ error: 'Unauthorized. Please login to send event invites.' });
    }

    // Ensure user is staff (portal type is 'staff')
    if (session.portalType !== 'staff') {
      return res.status(403).json({
        error: 'Forbidden. Only staff members can send event invites.',
      });
    }

    const {
      eventTitle,
      eventDate,
      eventDuration = 60,
      location,
      description,
      matterId,
      matterTitle,
      matterNumber,
      attendees = [],
      eventItemId,
    } = req.body;

    // Validate required fields
    if (!eventTitle || !eventDate || !location || !matterId || !matterNumber) {
      return res.status(400).json({
        error: 'Missing required fields: eventTitle, eventDate, location, matterId, matterNumber.',
      });
    }

    if (!Array.isArray(attendees) || attendees.length === 0) {
      return res.status(400).json({
        error: 'At least one attendee is required.',
      });
    }

    // Validate attendees
    for (const attendee of attendees) {
      if (!attendee.email || !attendee.name) {
        return res.status(400).json({
          error: 'Each attendee must have email and name.',
        });
      }
      if (!isValidEmail(attendee.email)) {
        return res.status(400).json({
          error: `Invalid email address: ${attendee.email}`,
        });
      }
    }

    // Initialize Vercel KV
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // Check rate limit (per sender email from session)
    const allowed = await checkEventInviteRateLimit(kv, session.email);
    if (!allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Maximum 20 event invites per hour per sender.',
      });
    }

    const matterReference = `${matterNumber}${matterTitle ? ` - ${matterTitle}` : ''}`;

    // Attempt to create Teams meeting
    const organizerEmail = session.email || process.env.TEAMS_ORGANIZER_EMAIL;
    let teamsLink = null;

    if (organizerEmail) {
      teamsLink = await createTeamsMeeting(organizerEmail, eventTitle, eventDate, eventDuration);
    }

    // Update SharePoint event with Teams link if available and itemId provided
    if (teamsLink && eventItemId) {
      try {
        const siteId = await getSiteId('client');
        const token = await getAccessToken();
        const listId = await getListId(siteId, 'Events', token, 'client:Events');
        await updateSharePointItem(siteId, listId, eventItemId, teamsLink);
      } catch (error) {
        // Log error but don't fail the entire request
        console.error('Failed to update SharePoint with Teams link:', error.message);
      }
    }

    // Send emails to all attendees
    const sentEmails = [];
    const failedEmails = [];

    for (const attendee of attendees) {
      try {
        const emailHtml = buildEventInviteEmail(
          eventTitle,
          eventDate,
          location,
          description,
          matterReference,
          attendee.name,
          teamsLink
        );

        const { error: sendError } = await resend.emails.send({
          from: 'Crimson & Quill <portal@cqadvocates.com>',
          to: [attendee.email.toLowerCase()],
          subject: `Event Invitation: ${eventTitle}`,
          html: emailHtml,
        });

        if (sendError) {
          failedEmails.push({
            email: attendee.email,
            error: sendError.message || 'Unknown error',
          });
        } else {
          sentEmails.push(attendee.email);
        }
      } catch (error) {
        failedEmails.push({
          email: attendee.email,
          error: error.message,
        });
      }
    }

    // If all emails failed, return error
    if (sentEmails.length === 0) {
      return res.status(500).json({
        error: 'Failed to send event invites to any attendees.',
        failedEmails,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Event invites sent to ${sentEmails.length} attendee(s).`,
      teamsLink: teamsLink || null,
      sentEmails,
      failedEmails: failedEmails.length > 0 ? failedEmails : null,
    });
  } catch (error) {
    console.error('send-event-invite error:', error);
    return res.status(500).json({
      error: 'An unexpected error occurred. Please try again.',
    });
  }
};

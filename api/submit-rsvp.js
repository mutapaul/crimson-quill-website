/**
 * Vercel Serverless Function: Submit Event RSVP
 * Records event attendance responses (accepted, declined, tentative)
 * Persists RSVP data to SharePoint EventRSVPs list via Microsoft Graph API
 * Uses JWT session validation from cq_session cookie
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// In-memory caches (persist across warm invocations)
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = {};
let listIdCache = {};

const SITE_PATHS = {
  client: 'cqadvocates.sharepoint.com:/sites/CQClientPortal',
  staff: 'cqadvocates.sharepoint.com:/sites/CQStaffPortal',
};

const VALID_RESPONSES = ['accepted', 'declined', 'tentative'];

/** Validate email format */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/** Get access token from Azure AD using client_credentials */
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

/** Call Microsoft Graph API with specified method and body */
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

  // For DELETE, 204 No Content is success
  if (method === 'DELETE' && resp.status === 204) {
    return { success: true };
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Graph API error (${resp.status}): ${errText}`);
  }

  // For successful responses, try to parse JSON
  if (resp.status === 204) {
    return { success: true };
  }

  return resp.json();
}

/** Resolve SharePoint site ID */
async function getSiteId(siteKey) {
  if (siteIdCache[siteKey] && Date.now() < (siteIdCache._exp || 0)) {
    return siteIdCache[siteKey];
  }
  const token = await getAccessToken();
  const data = await graphApi(`/sites/${SITE_PATHS[siteKey]}`, token);
  siteIdCache[siteKey] = data.id;
  siteIdCache._exp = Date.now() + 86400000; // 24h
  return data.id;
}

/** Resolve list ID by name */
async function getListId(siteId, listName, token, cacheKey) {
  if (listIdCache[cacheKey] && Date.now() < (listIdCache._exp || 0)) {
    return listIdCache[cacheKey];
  }

  const listsResp = await graphApi(`/sites/${siteId}/lists`, token);
  const targetList = listsResp.value.find(
    l => l.displayName === listName || l.displayName.toLowerCase() === listName.toLowerCase()
  );

  if (!targetList) {
    throw new Error(`List '${listName}' not found`);
  }

  listIdCache[cacheKey] = targetList.id;
  listIdCache._exp = Date.now() + 86400000; // 24h
  return targetList.id;
}

/** Create item in SharePoint list */
async function createItem(siteId, listId, fields, token) {
  const body = { fields };
  return graphApi(`/sites/${siteId}/lists/${listId}/items`, token, 'POST', body);
}

/** Main handler */
module.exports = async function handler(req, res) {
  // CORS
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

  // Verify session
  let decodedToken = null;
  try {
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
    const sessionCookie = cookies.find(c => c.startsWith('cq_session='));
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = sessionCookie.split('=')[1];
    decodedToken = jwt.verify(token, JWT_SECRET);
    // Session verified, user is authenticated
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { eventId, response, attendeeName, attendeeEmail } = req.body;

    // Validate required fields
    if (!eventId || !response) {
      return res.status(400).json({ error: 'Missing required fields: eventId, response' });
    }

    // Trim and validate response enum
    const trimmedResponse = (response || '').trim().toLowerCase();
    if (!VALID_RESPONSES.includes(trimmedResponse)) {
      return res.status(400).json({
        error: `Invalid response value. Must be one of: ${VALID_RESPONSES.join(', ')}`,
      });
    }

    // Validate eventId is a non-empty string
    if (typeof eventId !== 'string' || !eventId.trim()) {
      return res.status(400).json({ error: 'eventId must be a non-empty string' });
    }

    // Prepare attendee info (use authenticated user's email if not provided)
    const finalAttendeeName = (attendeeName || '').trim() || decodedToken.email || 'Anonymous';
    const finalAttendeeEmail = (attendeeEmail || '').trim() || decodedToken.email || '';

    // Email validation (only if provided)
    if (finalAttendeeEmail && !isValidEmail(finalAttendeeEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const fields = {
      EventID: eventId.trim(),
      AttendeeName: finalAttendeeName,
      AttendeeEmail: finalAttendeeEmail,
      Response: trimmedResponse,
      ResponseDate: new Date().toISOString(),
    };

    const token = await getAccessToken();
    const siteId = await getSiteId('client');
    const listId = await getListId(siteId, 'EventRSVPs', token, 'client:EventRSVPs');

    // Create RSVP record
    const result = await createItem(siteId, listId, fields, token);

    return res.status(201).json({
      success: true,
      message: 'RSVP recorded',
      rsvpId: result.id,
      eventId: eventId.trim(),
      response: trimmedResponse,
      attendeeName: finalAttendeeName,
      attendeeEmail: finalAttendeeEmail,
    });
  } catch (error) {
    console.error('RSVP submission error:', error.message);
    return res.status(500).json({ error: 'An internal error occurred' });
  }
};

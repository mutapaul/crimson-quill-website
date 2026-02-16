/**
 * One-time setup: Add required custom columns to the Events list
 * Staff-only, creates: Teams Link, Category, Description, Matter ID
 * DELETE THIS FILE after running successfully.
 */

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

let tokenCache = { token: null, expiresAt: 0 };

function validateSession(req) {
  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('cq_session='));
    if (!sessionCookie) return null;
    return jwt.verify(sessionCookie.split('=')[1], JWT_SECRET);
  } catch { return null; }
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }
  );

  if (!resp.ok) throw new Error(`Token failed: ${resp.status}`);
  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in * 1000) - 300000;
  return data.access_token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = validateSession(req);
  if (!session || session.portalType !== 'staff') {
    return res.status(403).json({ error: 'Staff access only' });
  }

  const results = { columns: [], errors: [] };

  try {
    const token = await getAccessToken();

    // Get site ID
    const siteResp = await fetch(
      'https://graph.microsoft.com/v1.0/sites/cqadvocates.sharepoint.com:/sites/CQClientPortal',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!siteResp.ok) throw new Error(`Site lookup failed: ${siteResp.status}`);
    const siteData = await siteResp.json();
    const siteId = siteData.id;

    // Find Events list
    const listsResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listsResp.ok) throw new Error(`Lists lookup failed: ${listsResp.status}`);
    const listsData = await listsResp.json();
    const eventsList = listsData.value.find(l => l.displayName === 'Events');
    if (!eventsList) throw new Error('Events list not found');

    const listId = eventsList.id;

    // Get existing columns
    const colsResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/columns`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const colsData = await colsResp.json();
    const existingCols = (colsData.value || []).map(c => c.name);

    // Define columns to create
    const columnsToCreate = [
      { name: 'Teams Link', displayName: 'Teams Link', description: 'Microsoft Teams meeting join URL', text: { maxLength: 500 } },
      { name: 'Category', displayName: 'Category', description: 'Event category', text: { maxLength: 255 } },
      { name: 'Description', displayName: 'Description', description: 'Event description', text: { allowMultipleLines: true, maxLength: 5000 } },
      { name: 'Matter ID', displayName: 'Matter ID', description: 'Linked matter identifier', text: { maxLength: 100 } },
    ];

    for (const col of columnsToCreate) {
      // Check if already exists (handle both display name and internal name)
      const internalName = col.name.replace(/ /g, '_x0020_');
      if (existingCols.includes(col.name) || existingCols.includes(internalName)) {
        results.columns.push({ name: col.name, status: 'already exists' });
        continue;
      }

      try {
        const createResp = await fetch(
          `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/columns`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(col),
          }
        );

        if (createResp.ok) {
          const created = await createResp.json();
          results.columns.push({ name: col.name, status: 'created', internalName: created.name });
        } else {
          const errText = await createResp.text();
          results.columns.push({ name: col.name, status: 'failed', error: errText });
          results.errors.push(`${col.name}: ${errText}`);
        }
      } catch (e) {
        results.columns.push({ name: col.name, status: 'error', error: e.message });
        results.errors.push(`${col.name}: ${e.message}`);
      }
    }

    // Now also check Teams meeting permissions
    results.teamsPermissionCheck = {};
    try {
      // Try to find a licensed user for Teams
      const usersResp = await fetch(
        'https://graph.microsoft.com/v1.0/users?$top=5&$select=id,userPrincipalName,displayName,assignedLicenses&$filter=accountEnabled eq true',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (usersResp.ok) {
        const usersData = await usersResp.json();
        const users = (usersData.value || []).map(u => ({
          email: u.userPrincipalName,
          name: u.displayName,
          hasLicenses: !!(u.assignedLicenses && u.assignedLicenses.length > 0),
        }));
        results.teamsPermissionCheck.users = users;
        results.teamsPermissionCheck.canListUsers = true;

        // Try creating a test meeting with the first licensed user
        const licensedUser = users.find(u => u.hasLicenses);
        if (licensedUser) {
          results.teamsPermissionCheck.testOrganizer = licensedUser.email;
          try {
            const now = new Date();
            const later = new Date(now.getTime() + 3600000);
            const meetingResp = await fetch(
              `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(licensedUser.email)}/onlineMeetings`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  startDateTime: now.toISOString(),
                  endDateTime: later.toISOString(),
                  subject: 'CQ Portal Test Meeting (auto-delete)',
                }),
              }
            );

            if (meetingResp.ok) {
              const meetingData = await meetingResp.json();
              results.teamsPermissionCheck.canCreateMeetings = true;
              results.teamsPermissionCheck.testMeetingLink = meetingData.joinWebUrl;
              results.teamsPermissionCheck.recommendedOrganizer = licensedUser.email;
            } else {
              const errText = await meetingResp.text();
              results.teamsPermissionCheck.canCreateMeetings = false;
              results.teamsPermissionCheck.meetingError = errText;
            }
          } catch (e) {
            results.teamsPermissionCheck.canCreateMeetings = false;
            results.teamsPermissionCheck.meetingError = e.message;
          }
        } else {
          results.teamsPermissionCheck.canCreateMeetings = false;
          results.teamsPermissionCheck.meetingError = 'No licensed users found';
        }
      } else {
        const errText = await usersResp.text();
        results.teamsPermissionCheck.canListUsers = false;
        results.teamsPermissionCheck.userError = errText;
      }
    } catch (e) {
      results.teamsPermissionCheck.error = e.message;
    }

    // Check token roles
    try {
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      results.appPermissions = payload.roles || [];
    } catch { results.appPermissions = 'Could not decode'; }

    results.envVars = {
      TEAMS_ORGANIZER_EMAIL: process.env.TEAMS_ORGANIZER_EMAIL || '(not set)',
    };

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message, partialResults: results });
  }
};

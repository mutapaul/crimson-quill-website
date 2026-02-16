/**
 * Diagnostic endpoint: Check Azure AD app permissions for Graph API
 * This helps verify that OnlineMeetings.ReadWrite.All and other required
 * permissions are configured. Staff-only access.
 */

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

let tokenCache = { token: null, expiresAt: 0 };

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
  tokenCache.expiresAt = Date.now() + (data.expires_in * 1000) - 300000;
  return data.access_token;
}

/** Decode JWT to extract roles/permissions without verification */
function decodeTokenClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Staff-only access
  const session = validateSession(req);
  if (!session || session.portalType !== 'staff') {
    return res.status(403).json({ error: 'Staff access only' });
  }

  const results = {
    timestamp: new Date().toISOString(),
    envVars: {},
    tokenInfo: {},
    permissions: {},
    tests: {},
  };

  // Check environment variables
  results.envVars = {
    AZURE_TENANT_ID: !!process.env.AZURE_TENANT_ID,
    AZURE_CLIENT_ID: !!process.env.AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET: !!process.env.AZURE_CLIENT_SECRET,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
    JWT_SECRET: !!process.env.JWT_SECRET,
    TEAMS_ORGANIZER_EMAIL: process.env.TEAMS_ORGANIZER_EMAIL || '(not set)',
  };

  try {
    // Get token and decode claims
    const token = await getAccessToken();
    const claims = decodeTokenClaims(token);

    if (claims) {
      results.tokenInfo = {
        appId: claims.appid || claims.azp || 'unknown',
        tenant: claims.tid || 'unknown',
        roles: claims.roles || [],
        scopes: claims.scp || 'none (app-only)',
        audience: claims.aud || 'unknown',
        expires: claims.exp ? new Date(claims.exp * 1000).toISOString() : 'unknown',
      };

      // Check specific required permissions
      const roles = claims.roles || [];
      results.permissions = {
        'Sites.Read.All': roles.includes('Sites.Read.All'),
        'Sites.ReadWrite.All': roles.includes('Sites.ReadWrite.All'),
        'OnlineMeetings.ReadWrite.All': roles.includes('OnlineMeetings.ReadWrite.All'),
        'User.Read.All': roles.includes('User.Read.All'),
        'Mail.Send': roles.includes('Mail.Send'),
        allRoles: roles,
      };
    }

    // Test 1: Can we list users? (needed for finding Teams organizer)
    try {
      const usersResp = await fetch(
        'https://graph.microsoft.com/v1.0/users?$top=3&$select=id,userPrincipalName,displayName,assignedLicenses',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (usersResp.ok) {
        const usersData = await usersResp.json();
        const users = (usersData.value || []).map(u => ({
          upn: u.userPrincipalName,
          name: u.displayName,
          hasLicenses: !!(u.assignedLicenses && u.assignedLicenses.length > 0),
          licenseCount: u.assignedLicenses ? u.assignedLicenses.length : 0,
        }));
        results.tests.listUsers = { success: true, users };
      } else {
        const errText = await usersResp.text();
        results.tests.listUsers = { success: false, status: usersResp.status, error: errText };
      }
    } catch (e) {
      results.tests.listUsers = { success: false, error: e.message };
    }

    // Test 2: Can we create a Teams meeting? (dry check)
    const organizerEmail = process.env.TEAMS_ORGANIZER_EMAIL;
    if (organizerEmail) {
      try {
        // Try to verify the organizer user exists
        const orgResp = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerEmail)}?$select=id,userPrincipalName,assignedLicenses`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (orgResp.ok) {
          const orgData = await orgResp.json();
          results.tests.teamsOrganizer = {
            success: true,
            email: organizerEmail,
            userId: orgData.id,
            hasLicenses: !!(orgData.assignedLicenses && orgData.assignedLicenses.length > 0),
          };
        } else {
          const errText = await orgResp.text();
          results.tests.teamsOrganizer = { success: false, status: orgResp.status, error: errText };
        }
      } catch (e) {
        results.tests.teamsOrganizer = { success: false, error: e.message };
      }
    } else {
      results.tests.teamsOrganizer = { success: false, error: 'TEAMS_ORGANIZER_EMAIL env var not set' };
    }

    // Test 3: Check if Events list has Teams_x0020_Link column
    try {
      const siteResp = await fetch(
        `https://graph.microsoft.com/v1.0/sites/cqadvocates.sharepoint.com:/sites/CQClientPortal`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (siteResp.ok) {
        const siteData = await siteResp.json();
        const siteId = siteData.id;

        const listsResp = await fetch(
          `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (listsResp.ok) {
          const listsData = await listsResp.json();
          const eventsList = listsData.value.find(l => l.displayName === 'Events');

          if (eventsList) {
            const columnsResp = await fetch(
              `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${eventsList.id}/columns`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (columnsResp.ok) {
              const columnsData = await columnsResp.json();
              const columnNames = columnsData.value.map(c => c.name);
              const hasTeamsLink = columnNames.includes('Teams_x0020_Link') || columnNames.includes('TeamsLink') || columnNames.includes('Teams Link');
              results.tests.eventsListColumns = {
                success: true,
                listId: eventsList.id,
                hasTeamsLinkColumn: hasTeamsLink,
                columns: columnNames.filter(n => !n.startsWith('_') && !n.startsWith('odata')),
              };
            }
          } else {
            results.tests.eventsListColumns = { success: false, error: 'Events list not found' };
          }
        }
      }
    } catch (e) {
      results.tests.eventsListColumns = { success: false, error: e.message };
    }

  } catch (error) {
    results.tokenInfo = { error: error.message };
  }

  // Generate recommendations
  results.recommendations = [];

  if (!results.permissions['OnlineMeetings.ReadWrite.All']) {
    results.recommendations.push(
      'ADD PERMISSION: Go to Azure Portal → App registrations → Your app → API permissions → Add → Microsoft Graph → Application → OnlineMeetings.ReadWrite.All → Grant admin consent'
    );
  }
  if (!results.permissions['User.Read.All']) {
    results.recommendations.push(
      'ADD PERMISSION: Go to Azure Portal → App registrations → Your app → API permissions → Add → Microsoft Graph → Application → User.Read.All → Grant admin consent'
    );
  }
  if (results.tests.teamsOrganizer && !results.tests.teamsOrganizer.success) {
    results.recommendations.push(
      'SET ENV VAR: Add TEAMS_ORGANIZER_EMAIL in Vercel → Settings → Environment Variables. Use the email of a Teams-licensed user in your organization.'
    );
  }
  if (results.tests.eventsListColumns && !results.tests.eventsListColumns.hasTeamsLinkColumn) {
    results.recommendations.push(
      'ADD COLUMN: In SharePoint → CQClientPortal site → Events list → Add column → Single line of text → Name it "Teams Link"'
    );
  }
  if (results.recommendations.length === 0) {
    results.recommendations.push('All checks passed! Teams meeting creation should work correctly.');
  }

  return res.status(200).json(results);
};

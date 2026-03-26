/**
 * ONE-TIME SETUP: Creates the MatterAccess SharePoint list
 * Run once via: GET https://www.cqadvocates.com/api/setup-matter-access-list?secret=CREATE_LIST_NOW
 * DELETE THIS FILE after successful creation.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

let tokenCache = { token: null, expiresAt: 0 };

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
    throw new Error(`Token request failed: ${resp.status}`);
  }

  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + data.expires_in * 1000 - 300000;
  return data.access_token;
}

module.exports = async function handler(req, res) {
  // Simple secret check to prevent unauthorized access
  if (req.query.secret !== 'CREATE_LIST_NOW') {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // Also require authenticated admin session
  try {
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
    const sessionCookie = cookies.find(c => c.startsWith('cq_session='));
    if (!sessionCookie) {
      return res.status(401).json({ error: 'Must be logged in as staff' });
    }
    const token = sessionCookie.split('=')[1];
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    const token = await getAccessToken();

    // Get site ID
    const siteResp = await fetch(
      'https://graph.microsoft.com/v1.0/sites/cqadvocates.sharepoint.com:/sites/CQClientPortal',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!siteResp.ok) {
      const err = await siteResp.text();
      return res.status(500).json({ error: 'Failed to get site', details: err });
    }

    const site = await siteResp.json();
    const siteId = site.id;

    // Check if list already exists
    const checkResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists?$filter=displayName eq 'MatterAccess'`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (checkResp.ok) {
      const checkData = await checkResp.json();
      if (checkData.value && checkData.value.length > 0) {
        return res.status(200).json({
          success: true,
          message: 'MatterAccess list already exists',
          listId: checkData.value[0].id,
        });
      }
    }

    // Create the list
    const createResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: 'MatterAccess',
          description: 'Stores external user access permissions for specific matters',
          list: {
            template: 'genericList',
          },
        }),
      }
    );

    if (!createResp.ok) {
      const err = await createResp.text();
      return res.status(500).json({ error: 'Failed to create list', details: err });
    }

    const list = await createResp.json();
    const listId = list.id;

    // Add columns one by one
    const columns = [
      {
        name: 'Email',
        text: { maxLength: 255 },
        description: 'Email address of the authorized user',
        required: true,
      },
      {
        name: 'PersonName',
        text: { maxLength: 255 },
        description: 'Display name of the authorized user',
      },
      {
        name: 'Matter_x0020_ID',
        text: { maxLength: 100 },
        description: 'Matter ID (e.g., CQ-M001)',
        required: true,
      },
      {
        name: 'MatterTitle',
        text: { maxLength: 255 },
        description: 'Matter title for display purposes',
      },
      {
        name: 'AccessLevel',
        choice: {
          choices: ['View Only', 'Contributor'],
          displayAs: 'dropDownMenu',
        },
        defaultValue: { value: 'View Only' },
        description: 'Access level: View Only (read/download) or Contributor (read/write/upload)',
      },
      {
        name: 'GrantedBy',
        text: { maxLength: 255 },
        description: 'Email of the staff member who granted access',
      },
      {
        name: 'GrantedDate',
        dateTime: { format: 'dateOnly' },
        description: 'Date access was granted',
      },
    ];

    const columnResults = [];

    for (const col of columns) {
      const colResp = await fetch(
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

      if (colResp.ok) {
        const colData = await colResp.json();
        columnResults.push({ name: col.name, status: 'created', id: colData.id });
      } else {
        const err = await colResp.text();
        columnResults.push({ name: col.name, status: 'failed', error: err });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'MatterAccess list created successfully',
      listId: listId,
      columns: columnResults,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Setup failed',
      message: error.message,
    });
  }
};

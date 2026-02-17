/**
 * Vercel Serverless Function: Staff Management
 * Manages staff members via a SharePoint "Staff" list on the CQClientPortal site.
 * Handles list creation (if missing), CRUD operations, and role management.
 * Uses Azure AD client_credentials auth with token caching.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = null;
let listIdCache = null;

const SITE_PATH = 'cqadvocates.sharepoint.com:/sites/CQClientPortal';

/** Get access token from Azure AD */
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

/** Resolve SharePoint site ID */
async function getSiteId(token) {
  if (siteIdCache && Date.now() < (siteIdCache.expiresAt || 0)) {
    return siteIdCache.id;
  }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${SITE_PATH}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to resolve site (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  siteIdCache = { id: data.id, expiresAt: Date.now() + 86400000 };
  return data.id;
}

/** Get or create the "Staff" list */
async function getOrCreateStaffList(siteId, token) {
  if (listIdCache && Date.now() < (listIdCache.expiresAt || 0)) {
    return listIdCache.id;
  }

  // Try to find existing list
  const listsResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listsResp.ok) {
    throw new Error(`Failed to fetch lists: ${await listsResp.text()}`);
  }

  const listsData = await listsResp.json();
  let staffList = (listsData.value || []).find(
    l => l.displayName === 'Staff' || l.displayName.toLowerCase() === 'staff'
  );

  if (!staffList) {
    // Create the "Staff" list with required columns
    const createResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: 'Staff',
          list: { template: 'genericList' },
          columns: [
            { name: 'StaffName', text: {}, required: true },
            { name: 'Email', text: {}, required: true },
            { name: 'Role', text: {}, required: true },
            { name: 'Phone', text: {} },
          ],
        }),
      }
    );

    if (!createResp.ok) {
      const errText = await createResp.text();
      throw new Error(`Failed to create Staff list (${createResp.status}): ${errText}`);
    }

    staffList = await createResp.json();
  }

  listIdCache = { id: staffList.id, expiresAt: Date.now() + 86400000 };
  return staffList.id;
}

/** Validate session from JWT cookie */
function validateSession(req) {
  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('cq_session='));

    if (!sessionCookie) return null;
    const token = sessionCookie.split('=')[1];
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/** Main handler */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Validate session
  const session = validateSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getAccessToken();
    const siteId = await getSiteId(token);
    const listId = await getOrCreateStaffList(siteId, token);

    // ===== GET: List all staff =====
    if (req.method === 'GET') {
      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!resp.ok) {
        throw new Error(`Failed to fetch staff: ${await resp.text()}`);
      }

      const data = await resp.json();
      const staff = (data.value || []).map(item => ({
        id: item.id,
        name: item.fields.StaffName || item.fields.Title || '',
        email: item.fields.Email || '',
        role: item.fields.Role || '',
        phone: item.fields.Phone || '',
      }));

      return res.status(200).json({ success: true, staff });
    }

    // ===== POST: Create new staff member =====
    if (req.method === 'POST') {
      const { name, email, role, phone } = req.body;

      if (!name || !email || !role) {
        return res.status(400).json({ error: 'Missing required fields: name, email, role' });
      }

      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              Title: name,
              StaffName: name,
              Email: email,
              Role: role,
              Phone: phone || '',
            },
          }),
        }
      );

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Failed to create staff (${resp.status}): ${errText}`);
      }

      const item = await resp.json();
      return res.status(201).json({
        success: true,
        message: 'Staff member created',
        staff: {
          id: item.id,
          name: item.fields.StaffName || item.fields.Title,
          email: item.fields.Email,
          role: item.fields.Role,
          phone: item.fields.Phone,
        },
      });
    }

    // ===== PATCH: Update staff member =====
    if (req.method === 'PATCH') {
      const { itemId, name, email, role, phone } = req.body;

      if (!itemId) {
        return res.status(400).json({ error: 'Missing required field: itemId' });
      }

      const fields = {};
      if (name !== undefined) { fields.Title = name; fields.StaffName = name; }
      if (email !== undefined) fields.Email = email;
      if (role !== undefined) fields.Role = role;
      if (phone !== undefined) fields.Phone = phone;

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
        throw new Error(`Failed to update staff (${resp.status}): ${errText}`);
      }

      return res.status(200).json({ success: true, message: 'Staff member updated' });
    }

    // ===== DELETE: Remove staff member =====
    if (req.method === 'DELETE') {
      const { itemId } = req.body;

      if (!itemId) {
        return res.status(400).json({ error: 'Missing required field: itemId' });
      }

      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${itemId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Failed to delete staff (${resp.status}): ${errText}`);
      }

      return res.status(200).json({ success: true, message: 'Staff member deleted' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Staff management error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

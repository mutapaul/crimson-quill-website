/**
 * Vercel Serverless Function: SharePoint Write API
 * Creates, updates, and deletes items in SharePoint lists via Microsoft Graph API
 * Uses Azure AD client_credentials auth with token caching
 */

// In-memory caches (persist across warm invocations)
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = {};
let listIdCache = {};

const SITE_PATHS = {
  client: 'cqadvocates.sharepoint.com:/sites/CQClientPortal',
  staff: 'cqadvocates.sharepoint.com:/sites/CQStaffPortal',
};

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

/** Update item in SharePoint list */
async function updateItem(siteId, listId, itemId, fields, token) {
  return graphApi(
    `/sites/${siteId}/lists/${listId}/items/${itemId}/fields`,
    token,
    'PATCH',
    fields
  );
}

/** Delete item from SharePoint list */
async function deleteItem(siteId, listId, itemId, token) {
  return graphApi(
    `/sites/${siteId}/lists/${listId}/items/${itemId}`,
    token,
    'DELETE'
  );
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

  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify session
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  if (!cookies.some(c => c.startsWith('cq_session='))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { site, list, fields, itemId } = req.body;

    // Validate required fields
    if (!site || !list) {
      return res.status(400).json({ error: 'Missing site or list parameter' });
    }

    if (!['client', 'staff'].includes(site)) {
      return res.status(400).json({ error: 'Invalid site: must be client or staff' });
    }

    // Validate method-specific requirements
    if (req.method === 'POST') {
      if (!fields || typeof fields !== 'object') {
        return res.status(400).json({ error: 'POST requires fields object' });
      }
    }

    if (req.method === 'PATCH' || req.method === 'DELETE') {
      if (!itemId) {
        return res.status(400).json({ error: `${req.method} requires itemId` });
      }
      if (req.method === 'PATCH' && (!fields || typeof fields !== 'object')) {
        return res.status(400).json({ error: 'PATCH requires fields object' });
      }
    }

    const token = await getAccessToken();
    const siteId = await getSiteId(site);
    const listId = await getListId(siteId, list, token, `${site}:${list}`);

    let result;

    if (req.method === 'POST') {
      result = await createItem(siteId, listId, fields, token);
      return res.status(201).json({
        success: true,
        message: `Item created in ${list}`,
        itemId: result.id,
        item: result,
      });
    }

    if (req.method === 'PATCH') {
      result = await updateItem(siteId, listId, itemId, fields, token);
      return res.status(200).json({
        success: true,
        message: `Item ${itemId} updated in ${list}`,
        itemId,
      });
    }

    if (req.method === 'DELETE') {
      result = await deleteItem(siteId, listId, itemId, token);
      return res.status(200).json({
        success: true,
        message: `Item ${itemId} deleted from ${list}`,
        itemId,
      });
    }
  } catch (error) {
    console.error('SharePoint write error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Vercel Serverless Function: SharePoint Data Proxy
 * Fetches SharePoint list data via Microsoft Graph API with Azure AD authentication
 */

// In-memory caches (persist across warm invocations)
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = {};

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

/** Call Microsoft Graph API */
async function graphApi(path, token) {
  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Graph API error (${resp.status}): ${errText}`);
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

/** Main handler */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify session
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  if (!cookies.some(c => c.startsWith('cq_session='))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { site, list, top } = req.query;
  if (!site || !list) {
    return res.status(400).json({ error: 'Missing site or list parameter' });
  }
  if (!['client', 'staff'].includes(site)) {
    return res.status(400).json({ error: 'Invalid site: must be client or staff' });
  }

  const topCount = Math.min(Math.max(parseInt(top) || 100, 1), 500);

  try {
    const token = await getAccessToken();
    const siteId = await getSiteId(site);

    // Document library
    if (list.toLowerCase() === 'documents' || list === 'Client Documents') {
      const libName = list === 'documents' ? 'Client Documents' : list;
      // Try to get the named library's drive
      try {
        const libs = await graphApi(
          `/sites/${siteId}/drives`,
          token
        );
        const lib = libs.value.find(d => d.name === libName || d.name === 'Documents');
        if (lib) {
          const files = await graphApi(
            `/drives/${lib.id}/root/children?$top=${topCount}`,
            token
          );
          return res.status(200).json({ success: true, type: 'documents', items: files.value || [] });
        }
      } catch (e) {
        // Fallback: try default drive
        const files = await graphApi(`/sites/${siteId}/drive/root/children?$top=${topCount}`, token);
        return res.status(200).json({ success: true, type: 'documents', items: files.value || [] });
      }
    }

    // Regular list
    const listsResp = await graphApi(`/sites/${siteId}/lists`, token);
    const targetList = listsResp.value.find(
      l => l.displayName === list || l.displayName.toLowerCase() === list.toLowerCase()
    );
    if (!targetList) {
      return res.status(404).json({ error: `List '${list}' not found` });
    }

    const items = await graphApi(
      `/sites/${siteId}/lists/${targetList.id}/items?$expand=fields&$top=${topCount}`,
      token
    );

    // Extract just the fields for cleaner output
    const cleanItems = (items.value || []).map(item => ({
      id: item.id,
      ...item.fields,
    }));

    return res.status(200).json({
      success: true,
      type: 'list',
      listName: targetList.displayName,
      items: cleanItems,
    });
  } catch (error) {
    console.error('SharePoint proxy error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Vercel Serverless Function: Upload Document to SharePoint
 * Uploads files to SharePoint "Client Documents" library on the client site
 * Uses Azure AD client_credentials auth with token caching
 * Accepts JSON with base64-encoded file data
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = {};
let driveIdCache = {};

const SITE_PATHS = {
  client: 'cqadvocates.sharepoint.com:/sites/CQClientPortal',
  staff: 'cqadvocates.sharepoint.com:/sites/CQStaffPortal',
};

// Allowed file types for upload
const ALLOWED_FILE_TYPES = ['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'txt', 'csv', 'msg'];

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

/** Resolve SharePoint site ID */
async function getSiteId(siteKey, token) {
  if (siteIdCache[siteKey] && Date.now() < (siteIdCache[siteKey].expiresAt || 0)) {
    return siteIdCache[siteKey].id;
  }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${SITE_PATHS[siteKey]}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to resolve site ${siteKey} (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  siteIdCache[siteKey] = { id: data.id, expiresAt: Date.now() + 86400000 };
  return data.id;
}

/** Get the drive ID for "Client Documents" library */
async function getDriveId(siteId, token) {
  if (driveIdCache['client-docs'] && Date.now() < (driveIdCache['client-docs'].expiresAt || 0)) {
    return driveIdCache['client-docs'].id;
  }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to get drives (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const clientDocsLib = data.value.find(
    d => d.name === 'Client Documents' || d.name === 'Documents'
  );

  if (!clientDocsLib) {
    throw new Error('Client Documents library not found');
  }

  driveIdCache['client-docs'] = { id: clientDocsLib.id, expiresAt: Date.now() + 86400000 };
  return clientDocsLib.id;
}

/** Upload file to SharePoint */
async function uploadToSharePoint(driveId, fileName, fileBuffer, matterTitle, token) {
  // Encode path components to handle special characters
  const encodedMatterTitle = encodeURIComponent(matterTitle);
  const encodedFileName = encodeURIComponent(fileName);

  const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/Client Portal/${encodedMatterTitle}/${encodedFileName}:/content`;

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: fileBuffer,
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    throw new Error(`Upload failed (${uploadResp.status}): ${errText}`);
  }

  return uploadResp.json();
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate session
  const session = validateSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { fileName, fileData, matterId, matterTitle } = req.body;

    // Validate required fields
    if (!fileName || !fileData || !matterId || !matterTitle) {
      return res.status(400).json({
        error: 'Missing required fields: fileName, fileData, matterId, matterTitle',
      });
    }

    // Validate file type
    const fileExtension = fileName.split('.').pop().toLowerCase();
    if (!ALLOWED_FILE_TYPES.includes(fileExtension)) {
      return res.status(400).json({
        error: `File type .${fileExtension} not allowed. Allowed types: ${ALLOWED_FILE_TYPES.join(', ')}`,
      });
    }

    // Decode base64 file data
    let fileBuffer;
    try {
      fileBuffer = Buffer.from(fileData, 'base64');
    } catch (err) {
      return res.status(400).json({ error: 'Invalid base64 file data' });
    }

    // Get tokens and IDs
    const token = await getAccessToken();
    const siteId = await getSiteId('client', token);
    const driveId = await getDriveId(siteId, token);

    // Upload to SharePoint
    const uploadedFile = await uploadToSharePoint(
      driveId,
      fileName,
      fileBuffer,
      matterTitle,
      token
    );

    return res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        name: uploadedFile.name,
        size: uploadedFile.size,
        webUrl: uploadedFile.webUrl,
        id: uploadedFile.id,
        createdDateTime: uploadedFile.createdDateTime,
      },
    });
  } catch (error) {
    console.error('Document upload error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

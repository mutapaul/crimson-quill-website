/**
 * Vercel Serverless Function: Download Document from SharePoint
 * Streams file content from SharePoint via Microsoft Graph API
 * Uses Azure AD client_credentials auth with token caching
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
let tokenCache = { token: null, expiresAt: 0 };

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

/** Get file metadata from SharePoint */
async function getFileMetadata(driveId, itemId, token) {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to get file metadata (${resp.status}): ${errText}`);
  }

  return resp.json();
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

/** Get MIME type from file extension */
function getMimeType(fileName) {
  const extension = fileName.split('.').pop().toLowerCase();
  const mimeTypes = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    msg: 'application/vnd.ms-outlook',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    zip: 'application/zip',
  };
  return mimeTypes[extension] || 'application/octet-stream';
}

/** Main handler */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://www.cqadvocates.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate session
  const session = validateSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { driveId, itemId } = req.query;

    // Validate required query parameters
    if (!driveId || !itemId) {
      return res.status(400).json({
        error: 'Missing required query parameters: driveId, itemId',
      });
    }

    // Get access token
    const token = await getAccessToken();

    // Get file metadata
    const fileMetadata = await getFileMetadata(driveId, itemId, token);

    // Get download URL from metadata
    const downloadUrl = fileMetadata['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new Error('Download URL not available for this file');
    }

    // Fetch file content from download URL
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) {
      throw new Error(`Failed to download file (${fileResp.status})`);
    }

    // Get MIME type
    const mimeType = fileMetadata.file
      ? fileMetadata.file.mimeType
      : getMimeType(fileMetadata.name);

    // Set response headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileMetadata.name)}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Stream file content
    const arrayBuf = await fileResp.arrayBuffer();
    res.status(200).send(Buffer.from(arrayBuf));
  } catch (error) {
    console.error('Document download error:', error.message);

    // Prevent multiple response writes
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message });
    }
  }
}

const { ConfidentialClientApplication } = require('@azure/identity');

// Cache the access token to avoid re-authenticating on every request
let cachedToken = null;
let tokenExpiry = 0;

async function getGraphToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get Graph token: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function graphGet(endpoint) {
  const token = await getGraphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error: ${res.status} ${err}`);
  }

  return res.json();
}

/**
 * Check if an email is a member of a specific security group.
 * @param {string} email - User email address
 * @param {string} groupId - Azure AD / SharePoint security group ID
 * @returns {boolean} True if the user is in the group
 */
async function isEmailInGroup(email, groupId) {
  try {
    // First, find the user by email (works for both internal and guest users)
    let userId = null;

    // Try finding as a regular user
    try {
      const userResult = await graphGet(
        `/users?$filter=mail eq '${encodeURIComponent(email)}' or userPrincipalName eq '${encodeURIComponent(email)}'&$select=id`
      );
      if (userResult.value && userResult.value.length > 0) {
        userId = userResult.value[0].id;
      }
    } catch (e) {
      // User not found as regular user, try guest
    }

    // If not found, try as guest user (external sharing creates guest accounts)
    if (!userId) {
      try {
        const guestUpn = email.replace('@', '_') + '#EXT#@' +
          process.env.AZURE_TENANT_ID.split('-')[0] + '.onmicrosoft.com';
        const guestResult = await graphGet(
          `/users?$filter=startswith(userPrincipalName,'${encodeURIComponent(email.replace('@', '_'))}')&$select=id,userPrincipalName`
        );
        if (guestResult.value && guestResult.value.length > 0) {
          userId = guestResult.value[0].id;
        }
      } catch (e) {
        // Guest user not found either
      }
    }

    if (!userId) {
      return false;
    }

    // Check group membership using transitiveMemberOf
    const memberCheck = await graphGet(
      `/users/${userId}/transitiveMemberOf?$filter=id eq '${groupId}'&$select=id`
    );

    return memberCheck.value && memberCheck.value.length > 0;
  } catch (error) {
    console.error('Error checking group membership:', error.message);
    return false;
  }
}

/**
 * Check if the email belongs to the firm domain (@cqadvocates.com)
 */
function isFirmEmail(email) {
  return email.toLowerCase().endsWith('@cqadvocates.com');
}

/**
 * Check if an email is registered in the SharePoint Clients list.
 * Queries the CQClientPortal site's "Clients" list for a matching Email field.
 * @param {string} email - Client email address to check
 * @returns {boolean} True if the email exists in the Clients list with Active status
 */
async function isRegisteredClient(email) {
  try {
    const token = await getGraphToken();
    const siteId = await getSiteIdByPath(token, 'cqadvocates.sharepoint.com:/sites/CQClientPortal');

    // Get the Clients list
    const listsResp = await graphGet(`/sites/${siteId}/lists`);
    const clientsList = listsResp.value.find(
      (l) => l.displayName === 'Clients' || l.displayName.toLowerCase() === 'clients'
    );

    if (!clientsList) {
      console.error('Clients list not found in CQClientPortal');
      return false;
    }

    // Query for the specific email (case-insensitive filter not supported in Graph for SP lists,
    // so we fetch all and filter in code — the Clients list should be small)
    const items = await graphGet(
      `/sites/${siteId}/lists/${clientsList.id}/items?$expand=fields&$top=500`
    );

    if (!items.value || items.value.length === 0) {
      return false;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const match = items.value.find((item) => {
      const itemEmail = (item.fields.Email || '').toLowerCase().trim();
      const status = (item.fields.Status || '').toLowerCase();
      return itemEmail === normalizedEmail && status === 'active';
    });

    return !!match;
  } catch (error) {
    console.error('Error checking registered client:', error.message);
    return false;
  }
}

/**
 * Helper to resolve a SharePoint site ID from its path
 */
async function getSiteIdByPath(token, sitePath) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${sitePath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to resolve site: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.id;
}

module.exports = { getGraphToken, graphGet, isEmailInGroup, isFirmEmail, isRegisteredClient };

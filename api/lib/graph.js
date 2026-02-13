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

module.exports = { getGraphToken, graphGet, isEmailInGroup, isFirmEmail };

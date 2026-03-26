/**
 * Azure Functions v4 — Register all API endpoints.
 *
 * This file wraps each existing Vercel-style handler using the
 * compatibility adapter and registers it as an Azure Functions HTTP trigger.
 */

const { app } = require('@azure/functions');
const { wrapVercelHandler } = require('../../_lib/azure-compat');

// Import all existing Vercel-style handlers
const checkSession     = require('../../check-session');
const downloadDocument = require('../../download-document');
const notifyClient     = require('../../notify-client');
const requestOtp       = require('../../request-otp');
const sendEventInvite  = require('../../send-event-invite');
const sendInvoiceEmail = require('../../send-invoice-email');
const sharepointWrite  = require('../../sharepoint-write');
const sharepoint       = require('../../sharepoint');
const submitRsvp       = require('../../submit-rsvp');
const uploadDocument   = require('../../upload-document');
const verifyOtp        = require('../../verify-otp');

// ── Register each function ─────────────────────────────────────

app.http('check-session', {
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'check-session',
  handler: wrapVercelHandler(checkSession),
});

app.http('download-document', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'download-document',
  handler: wrapVercelHandler(downloadDocument),
});

app.http('notify-client', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'notify-client',
  handler: wrapVercelHandler(notifyClient),
});

app.http('request-otp', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'request-otp',
  handler: wrapVercelHandler(requestOtp),
});

app.http('send-event-invite', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'send-event-invite',
  handler: wrapVercelHandler(sendEventInvite),
});

app.http('send-invoice-email', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'send-invoice-email',
  handler: wrapVercelHandler(sendInvoiceEmail),
});

app.http('sharepoint-write', {
  methods: ['POST', 'PATCH', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'sharepoint-write',
  handler: wrapVercelHandler(sharepointWrite),
});

app.http('sharepoint', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'sharepoint',
  handler: wrapVercelHandler(sharepoint),
});

app.http('submit-rsvp', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'submit-rsvp',
  handler: wrapVercelHandler(submitRsvp),
});

app.http('upload-document', {
  methods: ['POST', 'GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'upload-document',
  handler: wrapVercelHandler(uploadDocument),
});

app.http('verify-otp', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'verify-otp',
  handler: wrapVercelHandler(verifyOtp),
});

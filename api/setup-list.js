const jwt = require('jsonwebtoken');
module.exports = async function handler(req, res) {
  if (req.query.key !== 'cq2026') return res.status(403).json({ error: 'Forbidden' });
  try {
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
    const sc = cookies.find(c => c.startsWith('cq_session='));
    if (!sc) return res.status(401).json({ error: 'Login first' });
    jwt.verify(sc.split('=')[1], process.env.JWT_SECRET);
  } catch (e) { return res.status(401).json({ error: 'Bad session' }); }
  try {
    const body = new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const tr = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    if (!tr.ok) return res.status(500).json({ error: 'Token failed' });
    const { access_token: token } = await tr.json();
    const sr = await fetch('https://graph.microsoft.com/v1.0/sites/cqadvocates.sharepoint.com:/sites/CQClientPortal', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const site = await sr.json();
    const siteId = site.id;
    // Check if exists
    const lr = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const lists = await lr.json();
    const existing = (lists.value || []).find(l => l.displayName === 'MatterAccess');
    if (existing) return res.status(200).json({ success: true, message: 'Already exists', listId: existing.id });
    // Create list
    const cr = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'MatterAccess', list: { template: 'genericList' } }),
    });
    if (!cr.ok) { const e = await cr.text(); return res.status(500).json({ error: 'Create failed', d: e }); }
    const list = await cr.json();
    const lid = list.id;
    const cols = [
      { name: 'Email', text: { maxLength: 255 }, required: true },
      { name: 'PersonName', text: { maxLength: 255 } },
      { name: 'Matter_x0020_ID', text: { maxLength: 100 }, required: true },
      { name: 'MatterTitle', text: { maxLength: 255 } },
      { name: 'AccessLevel', choice: { choices: ['View Only', 'Contributor'], displayAs: 'dropDownMenu' }, defaultValue: { value: 'View Only' } },
      { name: 'GrantedBy', text: { maxLength: 255 } },
      { name: 'GrantedDate', text: { maxLength: 50 } },
    ];
    const results = [];
    for (const col of cols) {
      const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${lid}/columns`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(col),
      });
      results.push({ name: col.name, ok: r.ok });
    }
    return res.status(200).json({ success: true, listId: lid, columns: results });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};

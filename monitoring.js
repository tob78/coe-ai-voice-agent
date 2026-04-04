// monitoring.js — v3.9.73 — Komplett daglig e-post-rapport + varsling
// Alt kjører i Railway — ingen Tasklet-avhengighet
const nodemailer = require('nodemailer');

const ADMIN_PHONE = '+4797479157';
const ADMIN_EMAIL = 'tobiasbjorkhaug@gmail.com';
const GITHUB_TOKEN_EXPIRY = new Date('2026-06-22');
const RAILWAY_URL = 'https://backend-production-6779.up.railway.app';

// Gmail SMTP transporter — port 465 SSL (587 blokkeres av Railway)
const emailTransporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  connectionTimeout: 15000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  auth: {
    user: ADMIN_EMAIL,
    pass: (process.env.GMAIL_APP_PASSWORD || 'ytquiherohwgyazv').replace(/\s/g, '')
  }
});

let pool;
let lastDailyReport = null;
let lastSmsLimitAlert = null;
let lastGithubAlert = null;

// ============ HELPERS ============
function krFormat(amount) {
  return `${amount.toFixed(2)} kr`;
}

function pctBar(value, max) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const filled = Math.round(pct / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled) + ` ${pct}%`;
}

// ============ DATA COLLECTORS ============
async function getSystemHealth() {
  const health = { server: '✅ Oppe', db: '❌ Nede', uptime: 0 };
  health.uptime = Math.round(process.uptime() / 3600 * 10) / 10; // hours
  try {
    await pool.query('SELECT 1');
    health.db = '✅ OK';
  } catch (e) {
    health.db = `❌ ${e.message}`;
  }
  // Check Vapi
  try {
    const vapiKey = process.env.VAPI_PRIVATE_KEY;
    if (vapiKey) {
      const res = await fetch('https://api.vapi.ai/assistant', {
        headers: { 'Authorization': `Bearer ${vapiKey}` }
      });
      health.vapi = res.ok ? '✅ OK' : `⚠️ ${res.status}`;
    } else {
      health.vapi = '⚠️ Ingen API-nøkkel';
    }
  } catch (e) {
    health.vapi = `❌ ${e.message}`;
  }
  return health;
}

async function getCallStats() {
  const stats = { today: 0, week: 0, month: 0, byCompany: [], avgDuration: 0, failed: 0, bySource: {} };
  try {
    // Today
    const t = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE created_at > NOW() - INTERVAL '24 hours'`);
    stats.today = parseInt(t.rows[0].c);
    // Week
    const w = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE created_at > NOW() - INTERVAL '7 days'`);
    stats.week = parseInt(w.rows[0].c);
    // Month
    const m = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE created_at > NOW() - INTERVAL '30 days'`);
    stats.month = parseInt(m.rows[0].c);
    // By company
    const bc = await pool.query(`
      SELECT c.name, COUNT(cl.id) as count 
      FROM calls cl JOIN companies c ON cl.company_id = c.id 
      WHERE cl.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY c.name ORDER BY count DESC
    `);
    stats.byCompany = bc.rows;
    // Avg duration
    try {
      const ad = await pool.query(`
        SELECT AVG(duration) as avg_dur FROM calls 
        WHERE created_at > NOW() - INTERVAL '24 hours' AND duration > 0
      `);
      stats.avgDuration = Math.round(parseFloat(ad.rows[0]?.avg_dur || 0));
    } catch (e) { /* duration column might not exist */ }
    // Failed/aborted
    try {
      const f = await pool.query(`
        SELECT COUNT(*) as c FROM calls 
        WHERE created_at > NOW() - INTERVAL '24 hours' AND (status = 'failed' OR status = 'aborted')
      `);
      stats.failed = parseInt(f.rows[0].c);
    } catch (e) { /* */ }
    // By source (Telefon, Chatbot, Melding)
    try {
      const bs = await pool.query(`
        SELECT COALESCE(source, 'Telefon') as source, COUNT(*) as count
        FROM calls WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY source
      `);
      bs.rows.forEach(r => { stats.bySource[r.source] = parseInt(r.count); });
    } catch (e) { /* */ }
  } catch (err) {
    console.error('[MONITOR] Call stats error:', err.message);
  }
  return stats;
}

async function getSmsStats() {
  const stats = { today: 0, limit: 250, confirmSent: 0, staffSent: 0, reminderSent: 0, failed: 0, week: 0, month: 0 };
  try {
    const today = new Date().toISOString().split('T')[0];
    const t = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE DATE(created_at) = $1`, [today]);
    stats.today = parseInt(t.rows[0].c);
    // Week
    const w = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE created_at > NOW() - INTERVAL '7 days'`);
    stats.week = parseInt(w.rows[0].c);
    // Month
    const m = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE created_at > NOW() - INTERVAL '30 days'`);
    stats.month = parseInt(m.rows[0].c);
    // By type
    try {
      const types = await pool.query(`
        SELECT COALESCE(type, 'unknown') as type, COUNT(*) as count
        FROM messages WHERE DATE(created_at) = $1
        GROUP BY type
      `, [today]);
      types.rows.forEach(r => {
        if (r.type === 'confirm' || r.type === 'confirmation') stats.confirmSent = parseInt(r.count);
        else if (r.type === 'staff' || r.type === 'extract') stats.staffSent = parseInt(r.count);
        else if (r.type === 'reminder') stats.reminderSent = parseInt(r.count);
      });
    } catch (e) { /* */ }
    // Failed
    try {
      const f = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE DATE(created_at) = $1 AND status = 'failed'`, [today]);
      stats.failed = parseInt(f.rows[0].c);
    } catch (e) { /* */ }
  } catch (err) {
    console.error('[MONITOR] SMS stats error:', err.message);
  }
  return stats;
}

async function getBookingStats() {
  const stats = { today: 0, autoConfirmed: 0, manual: 0, inCalendar: 0, declined: 0, noShow: 0, week: 0, month: 0 };
  try {
    // Today
    const t = await pool.query(`SELECT COUNT(*) as c FROM bookings WHERE created_at > NOW() - INTERVAL '24 hours'`);
    stats.today = parseInt(t.rows[0].c);
    // Week
    const w = await pool.query(`SELECT COUNT(*) as c FROM bookings WHERE created_at > NOW() - INTERVAL '7 days'`);
    stats.week = parseInt(w.rows[0].c);
    // Month
    const m = await pool.query(`SELECT COUNT(*) as c FROM bookings WHERE created_at > NOW() - INTERVAL '30 days'`);
    stats.month = parseInt(m.rows[0].c);
    // Confirmed vs pending
    try {
      const conf = await pool.query(`
        SELECT confirmation_status, COUNT(*) as count
        FROM bookings WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY confirmation_status
      `);
      conf.rows.forEach(r => {
        if (r.confirmation_status === 'confirmed') stats.autoConfirmed = parseInt(r.count);
        else if (r.confirmation_status === 'pending') stats.manual = parseInt(r.count);
      });
    } catch (e) { /* */ }
    // Statuses
    try {
      const st = await pool.query(`
        SELECT status, COUNT(*) as count
        FROM bookings WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status
      `);
      st.rows.forEach(r => {
        if (r.status === 'declined' || r.status === 'rejected') stats.declined = parseInt(r.count);
        else if (r.status === 'no_show') stats.noShow = parseInt(r.count);
        else if (r.status === 'completed' || r.status === 'confirmed') stats.inCalendar = parseInt(r.count);
      });
    } catch (e) { /* */ }
  } catch (err) {
    console.error('[MONITOR] Booking stats error:', err.message);
  }
  return stats;
}

async function getChatbotStats() {
  const stats = { messagesIn: 0, bookingsFromChat: 0, failedWebhooks: 0 };
  try {
    const cb = await pool.query(`
      SELECT COUNT(*) as c FROM customers 
      WHERE source = 'Chatbot' AND created_at > NOW() - INTERVAL '24 hours'
    `);
    stats.messagesIn = parseInt(cb.rows[0].c);
    const bb = await pool.query(`
      SELECT COUNT(*) as c FROM bookings b
      JOIN customers cu ON b.customer_id = cu.id
      WHERE cu.source = 'Chatbot' AND b.created_at > NOW() - INTERVAL '24 hours'
    `);
    stats.bookingsFromChat = parseInt(bb.rows[0].c);
  } catch (e) { /* */ }
  return stats;
}

async function getSecurityStats() {
  const stats = { loginSuccess: 0, loginFailed: 0, lockedAccounts: 0, recentLogins: [] };
  try {
    const locked = await pool.query(`SELECT COUNT(*) as c FROM companies WHERE locked_out = true`);
    stats.lockedAccounts = parseInt(locked.rows[0].c);
  } catch (e) { /* */ }
  try {
    const success = await pool.query(`SELECT COUNT(*) as c FROM login_log WHERE success = true AND created_at > NOW() - INTERVAL '24 hours'`);
    stats.loginSuccess = parseInt(success.rows[0].c);
    const failed = await pool.query(`SELECT COUNT(*) as c FROM login_log WHERE success = false AND created_at > NOW() - INTERVAL '24 hours'`);
    stats.loginFailed = parseInt(failed.rows[0].c);
    const recent = await pool.query(`SELECT ip, success, company_name, created_at, user_agent FROM login_log WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 20`);
    stats.recentLogins = recent.rows;
  } catch (e) { /* login_log table may not exist yet */ }
  return stats;
}

async function getCostEstimates() {
  const costs = { companies: [] };
  try {
    const companies = await pool.query(`SELECT id, name FROM companies WHERE is_active = true ORDER BY id`);
    for (const co of companies.rows) {
      const calls = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE company_id = $1 AND created_at > NOW() - INTERVAL '30 days'`, [co.id]);
      const sms = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE company_id = $1 AND created_at > NOW() - INTERVAL '30 days'`, [co.id]);
      const callCount = parseInt(calls.rows[0].c);
      const smsCount = parseInt(sms.rows[0].c);

      // Estimater: Vapi ~1kr/min avg 3min, Twilio SMS ~0.75kr, OpenAI ~0.10kr/samtale
      const vapiCost = callCount * 3 * 1.0; // 3 min snitt × 1kr/min
      const smsCost = smsCount * 0.75;
      const openaiCost = callCount * 0.10;
      const total = vapiCost + smsCost + openaiCost;

      // Week estimate
      const callsW = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE company_id = $1 AND created_at > NOW() - INTERVAL '7 days'`, [co.id]);
      const smsW = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE company_id = $1 AND created_at > NOW() - INTERVAL '7 days'`, [co.id]);
      const callCountW = parseInt(callsW.rows[0].c);
      const smsCountW = parseInt(smsW.rows[0].c);
      const weekTotal = (callCountW * 3 * 1.0) + (smsCountW * 0.75) + (callCountW * 0.10);

      // Today
      const callsD = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE company_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [co.id]);
      const smsD = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE company_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [co.id]);
      const callCountD = parseInt(callsD.rows[0].c);
      const smsCountD = parseInt(smsD.rows[0].c);
      const dayTotal = (callCountD * 3 * 1.0) + (smsCountD * 0.75) + (callCountD * 0.10);

      costs.companies.push({
        name: co.name,
        calls: { day: callCountD, week: callCountW, month: callCount },
        sms: { day: smsCountD, week: smsCountW, month: smsCount },
        cost: { day: dayTotal, week: weekTotal, month: total },
        projected: total > 0 ? (total / 30 * 30) : 0
      });
    }
    // Totals
    costs.totalDay = costs.companies.reduce((s, c) => s + c.cost.day, 0);
    costs.totalWeek = costs.companies.reduce((s, c) => s + c.cost.week, 0);
    costs.totalMonth = costs.companies.reduce((s, c) => s + c.cost.month, 0);
  } catch (err) {
    console.error('[MONITOR] Cost estimate error:', err.message);
  }
  return costs;
}

// ============ BUILD EMAIL HTML ============
async function buildDailyEmail() {
  const [health, calls, sms, bookings, chatbot, security, costs] = await Promise.all([
    getSystemHealth(),
    getCallStats(),
    getSmsStats(),
    getBookingStats(),
    getChatbotStats(),
    getSecurityStats(),
    getCostEstimates()
  ]);

  const daysToGithub = Math.ceil((GITHUB_TOKEN_EXPIRY - new Date()) / (1000 * 60 * 60 * 24));
  const date = new Date().toLocaleDateString('no-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Warnings
  const warnings = [];
  if (sms.today >= 200) warnings.push(`🔴 SMS nærmer seg grensen: ${sms.today}/250`);
  if (sms.failed > 0) warnings.push(`🔴 ${sms.failed} SMS feilet i dag`);
  if (calls.failed > 0) warnings.push(`🟡 ${calls.failed} samtaler mislyktes/avbrutt`);
  if (daysToGithub <= 30) warnings.push(`⚠️ GitHub-token utløper om ${daysToGithub} dager`);
  if (security.lockedAccounts > 0) warnings.push(`🔒 ${security.lockedAccounts} låste kontoer`);
  if (health.db.includes('❌')) warnings.push(`🔴 Database-problem: ${health.db}`);
  if (health.vapi && health.vapi.includes('❌')) warnings.push(`🔴 Vapi-problem: ${health.vapi}`);

  const html = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; color: #333; }
  .container { max-width: 650px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; padding: 24px 30px; }
  .header h1 { margin: 0; font-size: 22px; }
  .header .date { opacity: 0.8; margin-top: 4px; font-size: 14px; }
  .section { padding: 20px 30px; border-bottom: 1px solid #eee; }
  .section h2 { margin: 0 0 12px 0; font-size: 16px; color: #1a1a2e; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .stat-box { background: #f8f9fa; border-radius: 8px; padding: 12px; text-align: center; }
  .stat-box .number { font-size: 24px; font-weight: bold; color: #1a1a2e; }
  .stat-box .label { font-size: 11px; color: #666; margin-top: 2px; }
  .warning-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px 14px; margin: 6px 0; border-radius: 4px; font-size: 13px; }
  .ok-box { background: #d4edda; border-left: 4px solid #28a745; padding: 10px 14px; margin: 6px 0; border-radius: 4px; font-size: 13px; }
  .error-box { background: #f8d7da; border-left: 4px solid #dc3545; padding: 10px 14px; margin: 6px 0; border-radius: 4px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table th { text-align: left; padding: 6px 8px; background: #f8f9fa; border-bottom: 2px solid #dee2e6; font-size: 11px; text-transform: uppercase; color: #666; }
  table td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  .cost { color: #e74c3c; font-weight: 600; }
  .links { padding: 16px 30px; background: #f8f9fa; text-align: center; }
  .links a { display: inline-block; margin: 4px 8px; padding: 8px 16px; background: #1a1a2e; color: white; text-decoration: none; border-radius: 6px; font-size: 13px; }
  .company-row td:first-child { font-weight: 600; }
  .bar { font-family: monospace; font-size: 11px; color: #666; }
  .footer { padding: 12px 30px; text-align: center; font-size: 11px; color: #999; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>📊 COE AI — Daglig Rapport</h1>
    <div class="date">${date}</div>
  </div>

  ${warnings.length > 0 ? `
  <div class="section">
    <h2>⚠️ Varsler</h2>
    ${warnings.map(w => w.includes('🔴') ? `<div class="error-box">${w}</div>` : `<div class="warning-box">${w}</div>`).join('')}
  </div>
  ` : `
  <div class="section">
    <div class="ok-box">✅ Alt ser bra ut — ingen varsler</div>
  </div>
  `}

  <div class="section">
    <h2>🏥 Systemstatus</h2>
    <table>
      <tr><td>Server</td><td>${health.server}</td><td>Oppetid: ${health.uptime}t</td></tr>
      <tr><td>Database</td><td>${health.db}</td><td></td></tr>
      <tr><td>Vapi API</td><td>${health.vapi || '—'}</td><td></td></tr>
      <tr><td>GitHub-token</td><td>${daysToGithub > 30 ? '✅' : '⚠️'} ${daysToGithub} dager igjen</td><td>Utløper 22. juni 2026</td></tr>
    </table>
  </div>

  <div class="section">
    <h2>📞 Samtaler</h2>
    <div class="grid">
      <div class="stat-box"><div class="number">${calls.today}</div><div class="label">I dag</div></div>
      <div class="stat-box"><div class="number">${calls.week}</div><div class="label">Denne uken</div></div>
      <div class="stat-box"><div class="number">${calls.month}</div><div class="label">Denne måneden</div></div>
    </div>
    ${calls.byCompany.length > 0 ? `
    <table style="margin-top:10px">
      <tr><th>Selskap</th><th>Samtaler (24t)</th></tr>
      ${calls.byCompany.map(r => `<tr><td>${r.name}</td><td>${r.count}</td></tr>`).join('')}
    </table>` : ''}
    ${calls.avgDuration ? `<p style="font-size:13px;color:#666;margin:8px 0 0">Snitt samtaletid: ${calls.avgDuration}s${calls.failed > 0 ? ` | ${calls.failed} mislykket` : ''}</p>` : ''}
    ${Object.keys(calls.bySource).length > 0 ? `<p style="font-size:13px;color:#666;margin:4px 0 0">Kilde: ${Object.entries(calls.bySource).map(([k,v]) => `${k}: ${v}`).join(' | ')}</p>` : ''}
  </div>

  <div class="section">
    <h2>📨 SMS</h2>
    <div class="grid">
      <div class="stat-box"><div class="number">${sms.today}</div><div class="label">I dag / ${sms.limit}</div></div>
      <div class="stat-box"><div class="number">${sms.week}</div><div class="label">Denne uken</div></div>
      <div class="stat-box"><div class="number">${sms.month}</div><div class="label">Denne måneden</div></div>
    </div>
    <div class="bar" style="margin-top:8px">Dagsforbruk: ${pctBar(sms.today, sms.limit)}</div>
    <table style="margin-top:8px">
      <tr><th>Type</th><th>Antall i dag</th></tr>
      <tr><td>✅ Bekreftelse til kunde</td><td>${sms.confirmSent}</td></tr>
      <tr><td>📋 Uttrekk til ansatt</td><td>${sms.staffSent}</td></tr>
      <tr><td>⏰ Påminnelse</td><td>${sms.reminderSent}</td></tr>
      <tr><td>❌ Feilet</td><td>${sms.failed}</td></tr>
    </table>
  </div>

  <div class="section">
    <h2>📅 Booking</h2>
    <div class="grid">
      <div class="stat-box"><div class="number">${bookings.today}</div><div class="label">I dag</div></div>
      <div class="stat-box"><div class="number">${bookings.week}</div><div class="label">Denne uken</div></div>
      <div class="stat-box"><div class="number">${bookings.month}</div><div class="label">Denne måneden</div></div>
    </div>
    <table style="margin-top:8px">
      <tr><td>✅ Automatisk bekreftet</td><td>${bookings.autoConfirmed}</td></tr>
      <tr><td>⏳ Manuell (venter)</td><td>${bookings.manual}</td></tr>
      <tr><td>📅 Lagt i kalender</td><td>${bookings.inCalendar}</td></tr>
      <tr><td>❌ Avslått</td><td>${bookings.declined}</td></tr>
      <tr><td>🚫 Ikke møtt</td><td>${bookings.noShow}</td></tr>
    </table>
  </div>

  <div class="section">
    <h2>💬 Chatbot (Base44)</h2>
    <table>
      <tr><td>Nye kunder via chatbot</td><td>${chatbot.messagesIn}</td></tr>
      <tr><td>Bookinger fra chatbot</td><td>${chatbot.bookingsFromChat}</td></tr>
    </table>
  </div>

  <div class="section">
    <h2>💰 Kostnadsestimat per selskap</h2>
    <table>
      <tr><th>Selskap</th><th>I dag</th><th>Uke</th><th>Måned</th></tr>
      ${costs.companies ? costs.companies.map(c => `
      <tr class="company-row">
        <td>${c.name}</td>
        <td class="cost">${krFormat(c.cost.day)}</td>
        <td class="cost">${krFormat(c.cost.week)}</td>
        <td class="cost">${krFormat(c.cost.month)}</td>
      </tr>
      <tr><td colspan="4" style="font-size:11px;color:#888;padding:2px 8px 8px">📞 ${c.calls.day}/${c.calls.week}/${c.calls.month} samtaler · 📨 ${c.sms.day}/${c.sms.week}/${c.sms.month} SMS</td></tr>
      `).join('') : '<tr><td colspan="4">Ingen data</td></tr>'}
      <tr style="font-weight:bold;border-top:2px solid #333">
        <td>TOTALT</td>
        <td class="cost">${krFormat(costs.totalDay || 0)}</td>
        <td class="cost">${krFormat(costs.totalWeek || 0)}</td>
        <td class="cost">${krFormat(costs.totalMonth || 0)}</td>
      </tr>
    </table>
    <p style="font-size:11px;color:#888;margin-top:6px">* Estimat basert på: Vapi ~1 kr/min (snitt 3 min/samtale), SMS ~0,75 kr/stk, OpenAI ~0,10 kr/samtale</p>
  </div>

  <div class="section">
    <h2>🔒 Sikkerhet</h2>
    <table>
      <tr><td>Vellykkede innlogginger (24t)</td><td>${security.loginSuccess}</td></tr>
      <tr><td>Feilede innlogginger (24t)</td><td>${security.loginFailed > 0 ? `🔴 ${security.loginFailed}` : '✅ 0'}</td></tr>
      <tr><td>Låste kontoer</td><td>${security.lockedAccounts > 0 ? `🔴 ${security.lockedAccounts}` : '✅ 0'}</td></tr>
      <tr><td>GitHub-token</td><td>${daysToGithub} dager igjen</td></tr>
    </table>
    ${security.recentLogins.length > 0 ? `
    <h3 style="margin-top:12px;font-size:14px">Siste innlogginger</h3>
    <table style="font-size:12px">
      <tr style="background:#1a2332;font-weight:bold"><td>Tid</td><td>IP</td><td>Status</td><td>Konto</td></tr>
      ${security.recentLogins.map(l => {
        const time = new Date(l.created_at).toLocaleTimeString('no-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit' });
        const status = l.success ? '✅' : '🔴 FEILET';
        const isSuspicious = !l.success || (l.ip && !l.ip.startsWith('10.') && !l.ip.startsWith('192.168.') && !l.ip.startsWith('127.'));
        const rowColor = !l.success ? 'background:#2a1a1a' : '';
        return `<tr style="${rowColor}"><td>${time}</td><td>${l.ip || 'ukjent'}</td><td>${status}</td><td>${l.company_name}</td></tr>`;
      }).join('')}
    </table>
    ` : ''}
  </div>

  <div class="links">
    <a href="${RAILWAY_URL}/api/monitoring/daily-report">📊 Kjør rapport</a>
    <a href="${RAILWAY_URL}/api/monitoring/sms-usage">📨 SMS-forbruk</a>
    <a href="${RAILWAY_URL}/api/monitoring/status">⚙️ Samlet status</a>
    <a href="${RAILWAY_URL}/crm/">🖥️ Åpne CRM</a>
  </div>

  <div class="footer">
    COE AI Voice Agent — Automatisk rapport generert ${new Date().toLocaleTimeString('no-NO', { timeZone: 'Europe/Oslo' })}
  </div>
</div>
</body>
</html>`;

  return { html, health, calls, sms, bookings, chatbot, security, costs, warnings, daysToGithub };
}

// ============ SEND EMAIL ============
async function sendDailyEmail() {
  if (!pool) return;
  console.log('[MONITOR] 📧 Building daily email report...');

  try {
    const report = await buildDailyEmail();
    
    const date = new Date().toLocaleDateString('no-NO', { day: 'numeric', month: 'short' });
    const subject = report.warnings.length > 0
      ? `⚠️ COE Rapport ${date} — ${report.warnings.length} varsel(er)`
      : `✅ COE Rapport ${date} — ${report.calls.today} samtaler, ${report.bookings.today} bookinger`;

    await emailTransporter.sendMail({
      from: `"COE AI Rapport" <${ADMIN_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject,
      html: report.html
    });

    console.log('[MONITOR] ✅ Daily email sent');
    lastDailyReport = { 
      time: new Date().toISOString(), 
      calls: report.calls.today,
      sms: report.sms.today,
      bookings: report.bookings.today,
      warnings: report.warnings.length
    };
    return report;
  } catch (err) {
    console.error('[MONITOR] ❌ Email send error:', err.message);
    // Fallback to SMS if email fails
    try {
      const { sendSms } = require('./sms-handler');
      await sendSms(ADMIN_PHONE, `COE: E-post-rapport feilet: ${err.message}. Sjekk logger.`, 'COE');
    } catch (e) { /* */ }
  }
}

// ============ SMS LIMIT CHECK ============
async function checkSmsLimit() {
  if (!pool) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM messages WHERE DATE(created_at) = $1`, [today]
    );
    const count = parseInt(result.rows[0].count);

    if (count >= 200) {
      const now = new Date().toISOString().split('T')[0];
      if (lastSmsLimitAlert === now) return;
      lastSmsLimitAlert = now;

      const msg = `SMS-VARSEL: ${count}/250 SMS brukt i dag! Nærmer seg grensen.`;
      console.log(`[MONITOR] 🔴 ${msg}`);
      try {
        const { sendSms } = require('./sms-handler');
        await sendSms(ADMIN_PHONE, msg, 'COE');
      } catch (e) {
        console.error('[MONITOR] SMS limit alert failed:', e.message);
      }
    }
  } catch (err) {
    console.error('[MONITOR] SMS limit check error:', err.message);
  }
}

// ============ GITHUB TOKEN REMINDER ============
function checkGithubToken() {
  const now = new Date();
  const daysLeft = Math.ceil((GITHUB_TOKEN_EXPIRY - now) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 14 && daysLeft > 0) {
    const today = new Date().toISOString().split('T')[0];
    if (lastGithubAlert === today) return;
    if (![14, 7, 3, 1].includes(daysLeft)) return;

    lastGithubAlert = today;
    const msg = `GitHub-token utloper om ${daysLeft} dager (22. juni 2026). Forny pa github.com/settings/tokens`;
    console.log(`[MONITOR] ⚠️ ${msg}`);

    try {
      const { sendSms } = require('./sms-handler');
      sendSms(ADMIN_PHONE, msg, 'COE');
    } catch (e) {
      console.error('[MONITOR] GitHub token alert failed:', e.message);
    }
  }
}

// ============ SCHEDULER ============
function startScheduler() {
  console.log('[MONITOR] 🕐 Monitoring scheduler started');

  setInterval(() => {
    const now = new Date();
    const osloTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Oslo' }));
    const hour = osloTime.getHours();
    const minute = osloTime.getMinutes();

    // Daily email at 08:00
    if (hour === 8 && minute === 0) {
      sendDailyEmail();
      checkGithubToken();
    }

    // SMS limit check every hour during business hours
    if (minute === 30 && hour >= 8 && hour <= 20) {
      checkSmsLimit();
    }
  }, 60000);

  // Startup check (delayed 30s)
  setTimeout(() => {
    checkGithubToken();
    console.log('[MONITOR] ✅ Startup checks done');
  }, 30000);
}

// ============ API ROUTES ============
function registerRoutes(app) {
  // Full daily report — sends email in background, returns data immediately
  app.get('/api/monitoring/daily-report', async (req, res) => {
    try {
      const report = await buildDailyEmail();
      // Send email in background (don't block response)
      sendDailyEmail().catch(err => console.error('[MONITOR] Background email error:', err.message));
      res.json({ 
        message: 'Rapport generert — e-post sendes i bakgrunnen',
        summary: {
          calls: report.calls.today,
          sms: report.sms.today,
          bookings: report.bookings.today,
          warnings: report.warnings
        },
        system: report.health,
        costs: report.costs
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SMS usage
  app.get('/api/monitoring/sms-usage', async (req, res) => {
    try {
      const stats = await getSmsStats();
      res.json({ ...stats, remaining: stats.limit - stats.today });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Combined status
  app.get('/api/monitoring/status', async (req, res) => {
    try {
      const [health, calls, sms, bookings, costs] = await Promise.all([
        getSystemHealth(),
        getCallStats(),
        getSmsStats(),
        getBookingStats(),
        getCostEstimates()
      ]);
      const daysToGithub = Math.ceil((GITHUB_TOKEN_EXPIRY - new Date()) / (1000 * 60 * 60 * 24));
      res.json({
        system: health,
        calls: { today: calls.today, week: calls.week, month: calls.month, failed: calls.failed },
        sms: { today: sms.today, limit: sms.limit, remaining: sms.limit - sms.today, failed: sms.failed },
        bookings: { today: bookings.today, week: bookings.week, month: bookings.month },
        costs: { day: costs.totalDay, week: costs.totalWeek, month: costs.totalMonth, companies: costs.companies },
        github: { daysLeft: daysToGithub, expires: '2026-06-22' },
        lastReport: lastDailyReport,
        uptime: Math.round(process.uptime() / 3600 * 10) / 10
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ============ INIT ============
function init(dbPool) {
  pool = dbPool;
  startScheduler();
  
  // Verify email on startup
  emailTransporter.verify((err) => {
    if (err) {
      console.error('[MONITOR] ❌ Gmail SMTP failed:', err.message);
    } else {
      console.log('[MONITOR] ✅ Gmail SMTP connected');
    }
  });
  
  console.log('[MONITOR] ✅ Monitoring module initialized (with email)');
}

module.exports = { init, registerRoutes, sendDailyEmail, checkSmsLimit, checkGithubToken };

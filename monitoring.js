// monitoring.js — Daglig rapport, SMS-grense, GitHub-token
// Erstatter Tasklet-triggers — kjører direkte i Railway
// Bruker eksisterende SMS-handler for varsling (ingen nodemailer)

const ADMIN_PHONE = '+4797479157';
const GITHUB_TOKEN_EXPIRY = new Date('2026-06-22');

let pool;
let lastDailyReport = null;
let lastSmsLimitAlert = null;
let lastGithubAlert = null;

// ============ DAILY REPORT ============
async function runDailyReport() {
  if (!pool) return;
  console.log('[MONITOR] 📊 Running daily report...');

  try {
    const stats = {};

    // Companies
    const companies = await pool.query('SELECT COUNT(*) as c FROM companies WHERE is_active = true');
    stats.companies = parseInt(companies.rows[0].c);

    // Calls last 24h
    const calls = await pool.query(`SELECT COUNT(*) as c FROM calls WHERE created_at > NOW() - INTERVAL '24 hours'`);
    stats.calls = parseInt(calls.rows[0].c);

    // Bookings last 24h
    const bookings = await pool.query(`SELECT COUNT(*) as c FROM bookings WHERE created_at > NOW() - INTERVAL '24 hours'`);
    stats.bookings = parseInt(bookings.rows[0].c);

    // SMS last 24h
    const sms = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE created_at > NOW() - INTERVAL '24 hours'`);
    stats.sms = parseInt(sms.rows[0].c);

    // Failed SMS last 24h
    let failedSms = 0;
    try {
      const failed = await pool.query(`SELECT COUNT(*) as c FROM messages WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'failed'`);
      failedSms = parseInt(failed.rows[0].c);
    } catch (e) { /* status column might not exist */ }

    // Availability setup
    const avail = await pool.query('SELECT DISTINCT company_id FROM availability WHERE is_active = true');
    stats.companiesWithAvailability = avail.rows.length;

    // Build summary
    const date = new Date().toLocaleDateString('no-NO');
    let report = `COE Rapport ${date}: `;
    report += `${stats.calls} samtaler, ${stats.bookings} bookinger, ${stats.sms} SMS`;
    if (failedSms > 0) report += ` (${failedSms} feilet!)`;
    if (stats.companiesWithAvailability < stats.companies) {
      report += ` | ${stats.companiesWithAvailability}/${stats.companies} har ledige tider`;
    }

    console.log(`[MONITOR] ${report}`);

    // Only SMS if there were issues or activity
    if (failedSms > 3 || stats.calls > 0) {
      try {
        const { sendSms } = require('./sms-handler');
        await sendSms(ADMIN_PHONE, report, 'COE');
      } catch (e) {
        console.error('[MONITOR] Could not send daily SMS:', e.message);
      }
    }

    lastDailyReport = { time: new Date().toISOString(), stats, report };
    return lastDailyReport;
  } catch (err) {
    console.error('[MONITOR] Daily report error:', err.message);
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
      // Don't spam — max 1 alert per day
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
    // Only alert once per day, and only on key days
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

  // Check every minute
  setInterval(() => {
    const now = new Date();
    const osloTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Oslo' }));
    const hour = osloTime.getHours();
    const minute = osloTime.getMinutes();

    // Daily report at 08:00
    if (hour === 8 && minute === 0) {
      runDailyReport();
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
  app.get('/api/monitoring/daily-report', async (req, res) => {
    try {
      const report = await runDailyReport();
      res.json(report || { message: 'No data yet' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/monitoring/sms-usage', async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await pool.query(
        `SELECT COUNT(*) as today_count FROM messages WHERE DATE(created_at) = $1`, [today]
      );
      const count = parseInt(result.rows[0].today_count);
      res.json({ today: count, limit: 250, remaining: 250 - count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/monitoring/status', (req, res) => {
    const daysToGithub = Math.ceil((GITHUB_TOKEN_EXPIRY - new Date()) / (1000 * 60 * 60 * 24));
    res.json({
      lastDailyReport,
      lastSmsLimitAlert,
      githubTokenDaysLeft: daysToGithub,
      uptime: process.uptime(),
    });
  });
}

// ============ INIT ============
function init(dbPool) {
  pool = dbPool;
  startScheduler();
  console.log('[MONITOR] ✅ Monitoring module initialized');
}

module.exports = { init, registerRoutes, runDailyReport, checkSmsLimit, checkGithubToken };

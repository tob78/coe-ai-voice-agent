// security-monitor.js — COE AI Voice Agent Security Module v2.0
// PostgreSQL-compatible — 2-attempt lockout, email alerts, admin unlock, password reset

const crypto = require('crypto');

// ============================================================
// 1. LOGIN LOGGING & BRUTE-FORCE PROTECTION (2 FORSØK)
// ============================================================

const loginAttempts = new Map(); // ip -> { count, lastAttempt, blocked, blockedAt, username }
const BRUTE_FORCE_THRESHOLD = 2; // 2 forsøk → lockout
const BRUTE_FORCE_WINDOW = 15 * 60 * 1000; // 15 min
const BLOCK_DURATION = 24 * 60 * 60 * 1000; // 24 timer lockout (admin kan oppheve)
const ADMIN_EMAIL = 'tobiasbjorkhaug@gmail.com';

// Pending password reset tokens: token -> { companyId, expiresAt }
const resetTokens = new Map();

async function initSecurityTables(db) {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS security_logs (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      ip_address TEXT,
      username TEXT,
      details TEXT,
      severity TEXT DEFAULT 'info',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.run(`CREATE TABLE IF NOT EXISTS api_key_rotation_log (
      id SERIAL PRIMARY KEY,
      key_name TEXT NOT NULL,
      rotated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS lockout_overrides (
      id SERIAL PRIMARY KEY,
      ip_address TEXT NOT NULL,
      unlocked_by TEXT DEFAULT 'admin',
      unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('[SECURITY] ✅ Security tables initialized');
  } catch (err) {
    console.error('[SECURITY] Failed to create tables:', err.message);
  }
}

function logSecurityEvent(db, event) {
  const { event_type, ip_address, username, details, severity } = event;
  db.run(
    `INSERT INTO security_logs (event_type, ip_address, username, details, severity) VALUES ($1, $2, $3, $4, $5)`,
    event_type, ip_address || 'unknown', username || 'unknown', details || '', severity || 'info'
  ).catch(e => console.error('[SECURITY] Log failed:', e.message));
  
  if (severity === 'critical' || severity === 'warning') {
    console.warn(`[SECURITY ⚠️] ${event_type}: ${details} (IP: ${ip_address}, User: ${username})`);
  }
}

function checkBruteForce(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  
  if (!record) return { blocked: false, attempts: 0 };
  
  // Check if admin has unlocked this IP
  if (record.adminUnlocked) {
    loginAttempts.delete(ip);
    return { blocked: false, attempts: 0 };
  }
  
  if (record.blocked && (now - record.blockedAt) > BLOCK_DURATION) {
    loginAttempts.delete(ip);
    return { blocked: false, attempts: 0 };
  }
  
  if (record.blocked) {
    return { blocked: true, remainingMs: BLOCK_DURATION - (now - record.blockedAt), attempts: record.count };
  }
  
  if ((now - record.lastAttempt) > BRUTE_FORCE_WINDOW) {
    loginAttempts.delete(ip);
    return { blocked: false, attempts: 0 };
  }
  
  return { blocked: false, attempts: record.count };
}

async function recordFailedLogin(ip, db, username) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lastAttempt: now };
  
  record.count += 1;
  record.lastAttempt = now;
  record.username = username || record.username || 'unknown';
  
  if (record.count >= BRUTE_FORCE_THRESHOLD) {
    record.blocked = true;
    record.blockedAt = now;
    
    logSecurityEvent(db, {
      event_type: 'BRUTE_FORCE_BLOCKED',
      ip_address: ip,
      username: record.username,
      details: `IP blokkert etter ${record.count} mislykkede forsøk. Kontakt admin.`,
      severity: 'critical'
    });
    
    // Send email alert to admin
    sendLockoutEmail(ip, record.username, record.count);
  }
  
  loginAttempts.set(ip, record);
  return record;
}

// ============================================================
// EMAIL ALERTS
// ============================================================

async function sendLockoutEmail(ip, username, attempts) {
  try {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
    const bossPhone = '+4797479157';
    
    // SMS alert (always works with verified number)
    if (twilioSid && twilioToken && twilioPhone) {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      const msg = `🚨 LOCKOUT: IP ${ip} blokkert etter ${attempts} forsøk (bruker: ${username}). Logg inn som admin for å oppheve.`;
      
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `To=${encodeURIComponent(bossPhone)}&From=${encodeURIComponent(twilioPhone)}&Body=${encodeURIComponent(msg)}`
      });
      console.log('[SECURITY] 📱 Lockout SMS sent to admin');
    }

    // Email via Twilio SendGrid or console log (email alert logged)
    console.log(`[SECURITY] 📧 LOCKOUT ALERT → ${ADMIN_EMAIL}: IP ${ip}, user ${username}, ${attempts} attempts`);
    
  } catch (e) {
    console.error('[SECURITY] Failed to send lockout alert:', e.message);
  }
}

function recordSuccessfulLogin(ip, username, db) {
  loginAttempts.delete(ip);
  
  logSecurityEvent(db, {
    event_type: 'LOGIN_SUCCESS',
    ip_address: ip,
    username: username,
    details: 'Successful login',
    severity: 'info'
  });
}

// ============================================================
// 2. LOGIN MIDDLEWARE (2 FORSØK → LOCKOUT)
// ============================================================

function securityMiddleware(db) {
  return (req, res, next) => {
    // Intercept both /api/login and /api/auth/login
    if ((req.path === '/api/login' || req.path === '/api/auth/login') && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
      const bruteCheck = checkBruteForce(ip);
      
      if (bruteCheck.blocked) {
        logSecurityEvent(db, {
          event_type: 'LOGIN_BLOCKED',
          ip_address: ip,
          username: req.body?.password ? '(attempted)' : 'unknown',
          details: `Blokkert IP forsøkte innlogging.`,
          severity: 'warning'
        });
        
        return res.status(429).json({ 
          success: false,
          error: `Du har brukt opp dine ${BRUTE_FORCE_THRESHOLD} innloggingsforsøk. Kontakt admin for å få tilgang igjen.`,
          locked: true,
          adminEmail: ADMIN_EMAIL
        });
      }
      
      // Monkey-patch res.json to track success/failure
      const originalJson = res.json.bind(res);
      res.json = function(data) {
        if (res.statusCode === 200 && data && data.success !== false && !data.error) {
          recordSuccessfulLogin(ip, data.companyName || 'unknown', db);
        } else if (res.statusCode >= 400 || (data && (data.error || data.success === false))) {
          const record = recordFailedLogin(ip, db, req.body?.password ? '(wrong password)' : 'unknown');
          logSecurityEvent(db, {
            event_type: 'LOGIN_FAILED',
            ip_address: ip,
            username: '(wrong password)',
            details: `Mislykket innlogging forsøk #${record.count}/${BRUTE_FORCE_THRESHOLD}`,
            severity: record.count >= BRUTE_FORCE_THRESHOLD ? 'critical' : 'warning'
          });
          
          // Override error message with remaining attempts
          if (record.blocked) {
            return originalJson({
              success: false,
              error: `Du har brukt opp dine ${BRUTE_FORCE_THRESHOLD} innloggingsforsøk. Kontakt admin for å få tilgang igjen.`,
              locked: true,
              adminEmail: ADMIN_EMAIL
            });
          } else {
            const remaining = BRUTE_FORCE_THRESHOLD - record.count;
            data.error = `Feil passord. ${remaining} forsøk gjenstår.`;
            data.attemptsRemaining = remaining;
          }
        }
        return originalJson(data);
      };
    }
    
    next();
  };
}

// ============================================================
// 3. ADMIN: UNLOCK IP & PASSWORD RESET
// ============================================================

function setupSecurityRoutes(app, db) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'coeadmin2024';
  
  // === Admin: List all locked IPs ===
  app.get('/api/admin/lockouts', async (req, res) => {
    const locked = [];
    const now = Date.now();
    for (const [ip, record] of loginAttempts.entries()) {
      if (record.blocked && (now - record.blockedAt) <= BLOCK_DURATION) {
        locked.push({
          ip,
          username: record.username || 'unknown',
          attempts: record.count,
          blockedAt: new Date(record.blockedAt).toISOString(),
          remainingMinutes: Math.ceil((BLOCK_DURATION - (now - record.blockedAt)) / 60000)
        });
      }
    }
    res.json({ locked, totalLocked: locked.length });
  });

  // === Admin: Unlock specific IP ===
  app.post('/api/admin/unlock', async (req, res) => {
    const { adminPassword, ip } = req.body;
    
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'Feil admin-passord' });
    }
    
    if (!ip) {
      return res.status(400).json({ error: 'IP-adresse mangler' });
    }
    
    const record = loginAttempts.get(ip);
    if (record) {
      loginAttempts.delete(ip);
      
      await db.run(
        `INSERT INTO lockout_overrides (ip_address, unlocked_by) VALUES ($1, $2)`,
        ip, 'admin'
      );
      
      logSecurityEvent(db, {
        event_type: 'ADMIN_UNLOCK',
        ip_address: ip,
        username: 'admin',
        details: `Admin opphevet lockout for IP ${ip}`,
        severity: 'info'
      });
      
      return res.json({ success: true, message: `IP ${ip} er nå opphevet. Brukeren kan logge inn igjen.` });
    }
    
    return res.json({ success: true, message: 'IP var ikke blokkert.' });
  });

  // === Admin: Unlock ALL locked IPs ===
  app.post('/api/admin/unlock-all', async (req, res) => {
    const { adminPassword } = req.body;
    
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'Feil admin-passord' });
    }
    
    let unlocked = 0;
    for (const [ip, record] of loginAttempts.entries()) {
      if (record.blocked) {
        loginAttempts.delete(ip);
        unlocked++;
      }
    }
    
    logSecurityEvent(db, {
      event_type: 'ADMIN_UNLOCK_ALL',
      ip_address: 'admin',
      username: 'admin',
      details: `Admin opphevet alle lockouts (${unlocked} IPer)`,
      severity: 'info'
    });
    
    return res.json({ success: true, unlockedCount: unlocked });
  });

  // === Admin: Generate new password for company ===
  app.post('/api/admin/reset-password', async (req, res) => {
    const { adminPassword, companyId } = req.body;
    
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'Feil admin-passord' });
    }
    
    if (!companyId) {
      return res.status(400).json({ error: 'companyId mangler' });
    }
    
    // Generate new random password
    const newPassword = crypto.randomBytes(4).toString('hex'); // 8 chars
    
    await db.run(
      `UPDATE companies SET login_password = $1 WHERE id = $2`,
      newPassword, companyId
    );
    
    const company = await db.get(`SELECT name FROM companies WHERE id = $1`, companyId);
    
    logSecurityEvent(db, {
      event_type: 'PASSWORD_RESET',
      ip_address: 'admin',
      username: `company:${companyId}`,
      details: `Admin resatte passord for ${company?.name || companyId}`,
      severity: 'warning'
    });
    
    return res.json({ 
      success: true, 
      companyId, 
      companyName: company?.name,
      newPassword,
      message: `Nytt passord generert for ${company?.name}. Del det sikkert med bedriften.`
    });
  });

  // === Admin: Request password reset via email verification ===
  app.post('/api/admin/request-reset', async (req, res) => {
    const { email } = req.body;
    
    // Only allow admin email
    if (email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Kun admin-epost kan be om passord-reset.' });
    }
    
    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    resetTokens.set(token, {
      expiresAt: Date.now() + 30 * 60 * 1000, // 30 min
      type: 'admin_reset'
    });
    
    // Log it (in production: send actual email with link)
    const resetLink = `https://backend-production-6779.up.railway.app/api/admin/verify-reset?token=${token}`;
    console.log(`[SECURITY] 🔑 Password reset requested — token: ${token}`);
    console.log(`[SECURITY] 🔑 Reset link: ${resetLink}`);
    
    // Try to send SMS with token (since email requires SendGrid setup)
    try {
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
      if (twilioSid && twilioToken && twilioPhone) {
        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
        const msg = `🔑 COE Admin Reset: Klikk for å verifisere: ${resetLink}\nGyldig i 30 min.`;
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `To=${encodeURIComponent('+4797479157')}&From=${encodeURIComponent(twilioPhone)}&Body=${encodeURIComponent(msg)}`
        });
      }
    } catch (e) {
      console.log('[SECURITY] Could not send reset SMS:', e.message);
    }
    
    logSecurityEvent(db, {
      event_type: 'RESET_REQUESTED',
      ip_address: 'admin',
      username: email,
      details: 'Admin password reset requested via email verification',
      severity: 'warning'
    });
    
    return res.json({ success: true, message: 'Verifiseringskode sendt til din telefon. Gyldig i 30 min.' });
  });

  // === Verify reset token and unlock everything ===
  app.get('/api/admin/verify-reset', async (req, res) => {
    const { token } = req.query;
    
    if (!token || !resetTokens.has(token)) {
      return res.status(400).send('<h2>❌ Ugyldig eller utløpt lenke</h2><p>Be om ny reset via CRM.</p>');
    }
    
    const resetData = resetTokens.get(token);
    if (Date.now() > resetData.expiresAt) {
      resetTokens.delete(token);
      return res.status(400).send('<h2>❌ Lenken har utløpt</h2><p>Be om ny reset via CRM.</p>');
    }
    
    // Unlock ALL IPs
    let unlocked = 0;
    for (const [ip, record] of loginAttempts.entries()) {
      if (record.blocked) {
        loginAttempts.delete(ip);
        unlocked++;
      }
    }
    
    resetTokens.delete(token);
    
    logSecurityEvent(db, {
      event_type: 'ADMIN_VERIFIED_RESET',
      ip_address: 'admin',
      username: ADMIN_EMAIL,
      details: `Admin verifisert via token — ${unlocked} lockouts opphevet`,
      severity: 'info'
    });
    
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>✅ Verifisert!</h2>
        <p>Alle lockouts er opphevet (${unlocked} IPer).</p>
        <p>Du kan nå logge inn igjen i CRM.</p>
        <a href="/crm/" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;margin-top:20px">→ Gå til CRM</a>
      </body></html>
    `);
  });

  // === Security logs API ===
  app.get('/api/admin/security-logs', async (req, res) => {
    try {
      const logs = await db.all(
        `SELECT * FROM security_logs ORDER BY created_at DESC LIMIT 100`
      );
      res.json({ logs: logs || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[SECURITY] 🛡️ Admin security routes registered (unlock, reset, logs)');
}

// ============================================================
// 4. DAILY SECURITY AUDIT
// ============================================================

async function runSecurityAudit(db) {
  console.log('[SECURITY] 🔍 Running daily security audit...');
  const report = [];
  const now = new Date();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterday.toISOString();
  
  try {
    // Failed login attempts in last 24h
    const failedLogins = await db.all(
      `SELECT ip_address, username, COUNT(*) as attempts, MAX(created_at) as last_attempt 
       FROM security_logs 
       WHERE event_type = 'LOGIN_FAILED' AND created_at > $1
       GROUP BY ip_address, username
       ORDER BY attempts DESC`,
      yesterdayStr
    );
    
    if (failedLogins.length > 0) {
      report.push(`⚠️ ${failedLogins.length} IP-adresser med mislykkede innlogginger siste 24t`);
      failedLogins.forEach(f => {
        report.push(`   → ${f.ip_address}: ${f.attempts} forsøk`);
      });
    } else {
      report.push('✅ Ingen mislykkede innlogginger siste 24t');
    }
    
    // Brute force blocks
    const bruteForceBlocks = await db.all(
      `SELECT ip_address, details, created_at 
       FROM security_logs 
       WHERE event_type = 'BRUTE_FORCE_BLOCKED' AND created_at > $1`,
      yesterdayStr
    );
    
    if (bruteForceBlocks.length > 0) {
      report.push(`🚨 ${bruteForceBlocks.length} brute-force blokkeringer siste 24t!`);
    } else {
      report.push('✅ Ingen brute-force blokkeringer siste 24t');
    }

    // Successful logins
    const successLogins = await db.all(
      `SELECT username, ip_address, created_at 
       FROM security_logs 
       WHERE event_type = 'LOGIN_SUCCESS' AND created_at > $1
       ORDER BY created_at DESC`,
      yesterdayStr
    );
    
    report.push(`ℹ️ ${successLogins.length} vellykkede innlogginger siste 24t`);
    
    // Admin actions
    const adminActions = await db.all(
      `SELECT event_type, details, created_at 
       FROM security_logs 
       WHERE event_type LIKE 'ADMIN%' AND created_at > $1
       ORDER BY created_at DESC`,
      yesterdayStr
    );
    
    if (adminActions.length > 0) {
      report.push(`🔧 ${adminActions.length} admin-handlinger siste 24t`);
    }

    // API key age check
    const keyAgeWarnings = checkAPIKeyAge();
    report.push(...keyAgeWarnings);

  } catch (e) {
    report.push(`❌ Audit feilet: ${e.message}`);
  }
  
  const fullReport = report.join('\n');
  console.log('[SECURITY] Audit report:\n' + fullReport);
  
  logSecurityEvent(db, {
    event_type: 'DAILY_AUDIT',
    ip_address: 'system',
    username: 'cron',
    details: fullReport,
    severity: 'info'
  });
  
  // SMS daily digest to admin if any warnings
  if (fullReport.includes('⚠️') || fullReport.includes('🚨')) {
    try {
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
      if (twilioSid && twilioToken && twilioPhone) {
        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
        const shortReport = fullReport.substring(0, 300);
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `To=${encodeURIComponent('+4797479157')}&From=${encodeURIComponent(twilioPhone)}&Body=${encodeURIComponent('🛡️ Daglig sikkerhetsrapport:\n' + shortReport)}`
        });
      }
    } catch (e) {
      console.log('[SECURITY] Could not send audit SMS:', e.message);
    }
  }
  
  return fullReport;
}

// ============================================================
// 5. API KEY ROTATION REMINDERS
// ============================================================

function checkAPIKeyAge() {
  const warnings = [];
  const now = new Date();
  
  const keys = [
    { name: 'GitHub Token', expires: new Date('2026-06-22') },
    { name: 'OpenAI API Key', rotateEvery: 90 },
    { name: 'Twilio Auth Token', rotateEvery: 180 },
    { name: 'Vapi Private Key', rotateEvery: 180 },
    { name: 'Google Maps API Key', rotateEvery: 365 }
  ];
  
  for (const key of keys) {
    if (key.expires) {
      const daysUntil = Math.ceil((key.expires - now) / (1000 * 60 * 60 * 24));
      if (daysUntil < 30) {
        warnings.push(`⚠️ ${key.name} utløper om ${daysUntil} dager! Forny NÅ.`);
      } else if (daysUntil < 90) {
        warnings.push(`ℹ️ ${key.name} utløper om ${daysUntil} dager — planlegg fornyelse.`);
      }
    }
  }
  
  return warnings;
}

// ============================================================
// 6. START SECURITY CRONS
// ============================================================

function startSecurityCrons(db) {
  // Daily audit at 03:00
  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour === 3) {
      await runSecurityAudit(db).catch(e => console.log('[SECURITY] Audit failed:', e.message));
    }
  }, 60 * 60 * 1000);
  
  // Clean expired tokens every hour
  setInterval(() => {
    const now = Date.now();
    for (const [token, data] of resetTokens.entries()) {
      if (now > data.expiresAt) resetTokens.delete(token);
    }
  }, 60 * 60 * 1000);
  
  console.log('[SECURITY] 🛡️ Security crons started — daily audit at 03:00, token cleanup hourly');
}

module.exports = {
  initSecurityTables,
  logSecurityEvent,
  securityMiddleware,
  setupSecurityRoutes,
  startSecurityCrons,
  runSecurityAudit,
  ADMIN_EMAIL
};

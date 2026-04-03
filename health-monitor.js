// ===== HEALTH MONITOR — Self-monitoring for Railway backend =====
// Runs internally every 15 minutes. Sends SMS alert on critical failures.
// No external dependency (Tasklet not needed for monitoring).

const { sendErrorAlert } = require('./sms-handler');

const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour between repeated alerts
const MAX_CONSECUTIVE_FAILURES = 3;

// State tracking
const state = {
  lastCheck: null,
  lastAlertSent: null,
  consecutiveFailures: 0,
  totalChecks: 0,
  totalFailures: 0,
  history: [], // last 100 checks
  startedAt: new Date().toISOString(),
  errors: [] // last 20 errors
};

// ===== INDIVIDUAL HEALTH CHECKS =====

async function checkDatabase(db) {
  const start = Date.now();
  try {
    const result = await db.get('SELECT COUNT(*) as count FROM companies');
    const latency = Date.now() - start;
    return {
      name: 'database',
      status: latency < 5000 ? 'ok' : 'slow',
      latency,
      details: { companies: result?.count || 0 }
    };
  } catch (err) {
    return {
      name: 'database',
      status: 'error',
      latency: Date.now() - start,
      error: err.message
    };
  }
}

async function checkOpenAI() {
  const start = Date.now();
  try {
    if (!process.env.OPENAI_API_KEY) {
      return { name: 'openai', status: 'error', latency: 0, error: 'API key missing' };
    }
    // Simple check — don't waste tokens, just verify key format
    const keyValid = process.env.OPENAI_API_KEY.startsWith('sk-');
    return {
      name: 'openai',
      status: keyValid ? 'ok' : 'warning',
      latency: Date.now() - start,
      details: { keyPresent: true, keyFormat: keyValid ? 'valid' : 'unusual' }
    };
  } catch (err) {
    return { name: 'openai', status: 'error', latency: Date.now() - start, error: err.message };
  }
}

async function checkTwilio() {
  const start = Date.now();
  try {
    const hasSid = !!process.env.TWILIO_ACCOUNT_SID;
    const hasToken = !!process.env.TWILIO_AUTH_TOKEN;
    const hasPhone = !!process.env.TWILIO_PHONE_NUMBER;
    const allPresent = hasSid && hasToken && hasPhone;
    return {
      name: 'twilio',
      status: allPresent ? 'ok' : 'error',
      latency: Date.now() - start,
      details: { sid: hasSid, token: hasToken, phone: hasPhone }
    };
  } catch (err) {
    return { name: 'twilio', status: 'error', latency: Date.now() - start, error: err.message };
  }
}

async function checkMemory() {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const heapPercent = Math.round((usage.heapUsed / usage.heapTotal) * 100);

  return {
    name: 'memory',
    status: heapPercent > 90 ? 'warning' : 'ok',
    details: {
      heapUsedMB,
      heapTotalMB,
      rssMB,
      heapPercent: heapPercent + '%'
    }
  };
}

async function checkRecentCalls(db) {
  try {
    // Check calls in last 24h
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total_24h,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as errors_24h,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_24h
      FROM calls 
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    const errorRate = stats?.total_24h > 0 
      ? Math.round((stats.errors_24h / stats.total_24h) * 100) 
      : 0;

    return {
      name: 'calls_24h',
      status: errorRate > 50 ? 'warning' : 'ok',
      details: {
        total: stats?.total_24h || 0,
        completed: stats?.completed_24h || 0,
        errors: stats?.errors_24h || 0,
        errorRate: errorRate + '%'
      }
    };
  } catch (err) {
    return { name: 'calls_24h', status: 'error', error: err.message };
  }
}

async function checkUptime() {
  const uptimeSeconds = process.uptime();
  const uptimeHours = Math.round(uptimeSeconds / 3600 * 10) / 10;
  const uptimeDays = Math.round(uptimeSeconds / 86400 * 10) / 10;

  return {
    name: 'uptime',
    status: 'ok',
    details: {
      seconds: Math.round(uptimeSeconds),
      hours: uptimeHours,
      days: uptimeDays
    }
  };
}

// ===== MAIN HEALTH CHECK =====

async function runHealthCheck(db) {
  const start = Date.now();
  state.totalChecks++;

  const checks = await Promise.allSettled([
    checkDatabase(db),
    checkOpenAI(),
    checkTwilio(),
    checkMemory(),
    checkRecentCalls(db),
    checkUptime()
  ]);

  const results = checks.map(c => c.status === 'fulfilled' ? c.value : {
    name: 'unknown',
    status: 'error',
    error: c.reason?.message || 'Check failed'
  });

  const hasErrors = results.some(r => r.status === 'error');
  const hasWarnings = results.some(r => r.status === 'warning');
  const overallStatus = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ok';
  const totalLatency = Date.now() - start;

  const checkResult = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    latency: totalLatency,
    checks: results
  };

  // Update state
  state.lastCheck = checkResult;
  state.history.push({ status: overallStatus, timestamp: checkResult.timestamp, latency: totalLatency });
  if (state.history.length > 100) state.history.shift();

  // Handle failures
  if (hasErrors) {
    state.consecutiveFailures++;
    state.totalFailures++;
    const errorDetails = results.filter(r => r.status === 'error').map(r => `${r.name}: ${r.error || 'failed'}`).join(', ');
    state.errors.push({ timestamp: checkResult.timestamp, details: errorDetails });
    if (state.errors.length > 20) state.errors.shift();

    // Alert after 3 consecutive failures, with cooldown
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const now = Date.now();
      if (!state.lastAlertSent || (now - state.lastAlertSent) > ALERT_COOLDOWN) {
        state.lastAlertSent = now;
        console.error(`🚨 HEALTH ALERT: ${state.consecutiveFailures} consecutive failures! Errors: ${errorDetails}`);

        // Try to send SMS alert
        try {
          await sendErrorAlert(
            { boss_phone: process.env.BOSS_PHONE || '+4797479157', name: 'System' },
            null,
            `SYSTEM HELSESJEKK FEILET ${state.consecutiveFailures}x!\n\nFeil: ${errorDetails}\n\nSjekk: ${process.env.BASE_URL || 'railway'}/health/detailed`,
            null
          );
          console.log('📱 Health alert SMS sent to boss');
        } catch (smsErr) {
          console.error('❌ Could not send health alert SMS:', smsErr.message);
        }
      }
    }
  } else {
    if (state.consecutiveFailures > 0) {
      console.log(`✅ Health recovered after ${state.consecutiveFailures} failures`);
    }
    state.consecutiveFailures = 0;
  }

  console.log(`🏥 Health check: ${overallStatus} (${totalLatency}ms) — checks: ${state.totalChecks}, failures: ${state.totalFailures}`);
  return checkResult;
}

// ===== GET FULL STATUS (for /health/detailed endpoint) =====

function getDetailedStatus() {
  const uptime = process.uptime();
  return {
    status: state.lastCheck?.status || 'unknown',
    version: '3.9.28',
    monitor: {
      startedAt: state.startedAt,
      totalChecks: state.totalChecks,
      totalFailures: state.totalFailures,
      consecutiveFailures: state.consecutiveFailures,
      lastAlertSent: state.lastAlertSent ? new Date(state.lastAlertSent).toISOString() : null,
      checkInterval: '15 min'
    },
    server: {
      uptimeSeconds: Math.round(uptime),
      uptimeHours: Math.round(uptime / 3600 * 10) / 10,
      uptimeDays: Math.round(uptime / 86400 * 10) / 10,
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform
    },
    lastCheck: state.lastCheck,
    recentHistory: state.history.slice(-20),
    recentErrors: state.errors.slice(-10)
  };
}

// ===== START MONITOR (called once at server startup) =====

// ===== STALE CALL CLEANUP — marks abandoned calls =====
async function cleanupStaleCalls(db) {
  try {
    // Calls still 'in-progress' after 30 min are abandoned/hangup
    const stale = await db.query(
      `UPDATE calls SET status = 'completed', call_outcome = COALESCE(NULLIF(call_outcome, ''), 'hangup')
       WHERE status = 'in-progress' AND created_at < NOW() - INTERVAL '30 minutes'
       RETURNING id, twilio_call_sid`
    );
    if (stale.rows.length > 0) {
      console.log(`🧹 Cleaned up ${stale.rows.length} stale calls:`, stale.rows.map(r => r.id));
      // Save transcript from session for each stale call
      for (const row of stale.rows) {
        try {
          const session = await db.get('SELECT * FROM call_sessions WHERE call_sid = $1', row.twilio_call_sid);
          if (session) {
            const history = JSON.parse(session.conversation_history || '[]');
            const transcript = history.map(msg => `${msg.role === 'assistant' ? 'AI' : 'Kunde'}: ${msg.content}`).join('\n');
            if (transcript) {
              await db.run('UPDATE calls SET transcript = COALESCE(NULLIF(transcript, \'\'), $1) WHERE id = $2', transcript, row.id);
            }
          }
        } catch (e) { /* best effort */ }
      }
    }
  } catch (err) {
    console.error('⚠️ Stale call cleanup error:', err.message);
  }
}

function startHealthMonitor(db) {
  console.log('🏥 Health monitor started — checking every 15 minutes');

  // Run first check after 30 seconds (let server warm up)
  setTimeout(() => {
    runHealthCheck(db);
  }, 30000);

  // Then every 15 minutes
  setInterval(() => {
    runHealthCheck(db).catch(err => {
      console.error('❌ Health check crashed:', err.message);
    });
    // Also cleanup stale calls
    cleanupStaleCalls(db).catch(err => {
      console.error('❌ Stale call cleanup crashed:', err.message);
    });
  }, CHECK_INTERVAL);
}

module.exports = {
  startHealthMonitor,
  runHealthCheck,
  getDetailedStatus
};

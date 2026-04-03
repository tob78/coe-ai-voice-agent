// ===== COE COST MONITOR — PostgreSQL-compatible =====
// Overvåker forbruk og varsler ved unormalt høye kostnader

// ===== Kostnadsgrenser per tjeneste (månedlig, i USD) =====
const COST_LIMITS = {
  openai: { warn: 40, critical: 60, name: 'OpenAI' },
  twilio: { warn: 10, critical: 20, name: 'Twilio' },
  railway: { warn: 10, critical: 15, name: 'Railway' },
  google_maps: { warn: 5, critical: 10, name: 'Google Maps' }
};

// ===== Init cost tracking table =====
async function initCostTables(db) {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS cost_tracking (
      id SERIAL PRIMARY KEY,
      service TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      period TEXT NOT NULL,
      checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.run(`CREATE TABLE IF NOT EXISTS cost_alerts (
      id SERIAL PRIMARY KEY,
      service TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      amount NUMERIC,
      message TEXT,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('💰 Cost tracking tables ready');
  } catch (e) {
    console.error('💰 Cost tables init failed:', e.message);
  }
}

// ===== Check OpenAI usage =====
async function checkOpenAICost() {
  try {
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    
    const response = await fetch(`https://api.openai.com/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${now.toISOString().split('T')[0]}`, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    
    if (response.ok) {
      const data = await response.json();
      return { service: 'openai', amount: (data.total_usage || 0) / 100 };
    }
    return null;
  } catch (e) {
    console.log('⚠️ Could not check OpenAI cost:', e.message);
    return null;
  }
}

// ===== Track daily call volume (proxy for cost) =====
async function checkCallVolumeCost(db) {
  try {
    const result = await db.get(`
      SELECT COUNT(*) as call_count, 
             COALESCE(SUM(CAST(call_duration AS NUMERIC)), 0) as total_minutes
      FROM calls 
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);
    
    const estimatedCost = (result.total_minutes || 0) * 0.43;
    return {
      calls: result.call_count || 0,
      totalMinutes: Math.round(result.total_minutes || 0),
      estimatedMonthlyCost: Math.round(estimatedCost * 100) / 100
    };
  } catch (e) {
    return { calls: 0, totalMinutes: 0, estimatedMonthlyCost: 0 };
  }
}

// ===== Daily cost check =====
async function runDailyCostCheck(db) {
  console.log('💰 Running daily cost check...');
  const alerts = [];
  
  const callStats = await checkCallVolumeCost(db);
  console.log(`💰 Last 30 days: ${callStats.calls} calls, ${callStats.totalMinutes} min, est. $${callStats.estimatedMonthlyCost}`);
  
  // Log to DB
  await db.run(
    `INSERT INTO cost_tracking (service, amount, period) VALUES ($1, $2, $3)`,
    'total_estimated', callStats.estimatedMonthlyCost, new Date().toISOString().slice(0, 7)
  );
  
  // Check if over limits
  const totalEstimate = callStats.estimatedMonthlyCost;
  const totalLimit = Object.values(COST_LIMITS).reduce((sum, l) => sum + l.warn, 0);
  
  if (totalEstimate > totalLimit) {
    const msg = `⚠️ KOSTNADSVARSEL: Estimert månedskostnad $${totalEstimate} overstiger varslingsgrense $${totalLimit}. ${callStats.calls} samtaler siste 30 dager.`;
    alerts.push(msg);
  }
  
  // Check for sudden spikes (>3x average daily)
  try {
    const avgResult = await db.get(`
      SELECT AVG(daily_count) as avg_daily FROM (
        SELECT DATE(created_at) as day, COUNT(*) as daily_count
        FROM calls
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
      ) sub
    `);
    
    const todayResult = await db.get(`
      SELECT COUNT(*) as today_count FROM calls 
      WHERE DATE(created_at) = CURRENT_DATE
    `);
    
    const avgDaily = parseFloat(avgResult?.avg_daily) || 0;
    const todayCount = parseInt(todayResult?.today_count) || 0;
    
    if (avgDaily > 0 && todayCount > avgDaily * 3) {
      const msg = `🚨 SPIKE DETEKTERT: ${todayCount} samtaler i dag vs gjennomsnitt ${Math.round(avgDaily)}/dag. Mulig misbruk?`;
      alerts.push(msg);
    }
  } catch (e) {
    console.log('⚠️ Spike check failed:', e.message);
  }
  
  // Send SMS alerts if needed
  if (alerts.length > 0) {
    const bossPhone = '+4797479157';
    try {
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
      
      for (const alert of alerts) {
        await db.run(
          `INSERT INTO cost_alerts (service, alert_type, amount, message) VALUES ($1, $2, $3, $4)`,
          'total', totalEstimate > totalLimit ? 'over_limit' : 'spike',
          totalEstimate, alert
        );
        
        if (twilioSid && twilioToken && twilioPhone) {
          const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `To=${encodeURIComponent(bossPhone)}&From=${encodeURIComponent(twilioPhone)}&Body=${encodeURIComponent(alert)}`
          });
          console.log('💰 Cost alert SMS sent:', alert);
        }
      }
    } catch (e) {
      console.log('⚠️ Could not send cost alert SMS:', e.message);
    }
  }
  
  return { callStats, alerts };
}

// ===== Cost summary API endpoint =====
function setupCostRoutes(app, db) {
  app.get('/api/costs/summary', async (req, res) => {
    try {
      const callStats = await checkCallVolumeCost(db);
      const recentAlerts = await db.all(
        `SELECT * FROM cost_alerts ORDER BY sent_at DESC LIMIT 10`
      );
      const costHistory = await db.all(
        `SELECT * FROM cost_tracking ORDER BY checked_at DESC LIMIT 30`
      );
      
      res.json({
        current: callStats,
        limits: COST_LIMITS,
        recentAlerts: recentAlerts || [],
        history: costHistory || []
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  console.log('💰 Cost API routes registered');
}

// ===== Start daily cost cron (runs at 08:00 every day) =====
function startCostMonitor(db) {
  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour === 8) {
      await runDailyCostCheck(db).catch(e => console.log('💰 Daily cost check failed:', e.message));
    }
  }, 60 * 60 * 1000);
  
  console.log('💰 Cost monitor active — daily check at 08:00');
}

module.exports = { initCostTables, runDailyCostCheck, startCostMonitor, setupCostRoutes };

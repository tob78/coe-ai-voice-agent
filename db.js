// ===== DATABASE MODULE =====
// PostgreSQL database for CRM data (persistent on Railway)

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set! Please add it as a Railway variable.');
  console.error('   Server will start without database.');
}

console.log('🔌 Connecting to PostgreSQL...');
if (process.env.DATABASE_URL) {
  console.log('   URL prefix:', process.env.DATABASE_URL.substring(0, 30) + '...');
}

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  max: 10,
}) : null;

// ===== Helper functions =====
const db = {
  query: (sql, params) => {
    if (!pool) throw new Error('Database not configured');
    return pool.query(sql, params);
  },
  get: async (sql, ...params) => {
    if (!pool) throw new Error('Database not configured');
    const r = await pool.query(sql, params);
    return r.rows[0] || null;
  },
  all: async (sql, ...params) => {
    if (!pool) throw new Error('Database not configured');
    const r = await pool.query(sql, params);
    return r.rows;
  },
  run: async (sql, ...params) => {
    if (!pool) throw new Error('Database not configured');
    const r = await pool.query(sql, params);
    return r;
  },
};

// ===== Schema =====
async function initDatabase() {
  if (!pool) {
    console.log('⚠️ No DATABASE_URL — skipping database init');
    return;
  }

  // Test connection first
  console.log('🔌 Testing database connection...');
  const client = await pool.connect();
  console.log('✅ Database connection successful!');
  client.release();

  // Create tables one by one for better error reporting
  console.log('📦 Creating tables...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      industry TEXT NOT NULL DEFAULT 'generell',
      phone TEXT,
      greeting TEXT,
      montour_phone TEXT,
      industry_questions TEXT DEFAULT '[]',
      follow_up_triggers TEXT DEFAULT '{}',
      standard_routines TEXT DEFAULT '[]',
      sms_template TEXT,
      system_prompt TEXT,
      login_password TEXT,
      boss_phone TEXT,
      boss_email TEXT,
      sms_notify_worker BOOLEAN DEFAULT true,
      sms_confirm_customer BOOLEAN DEFAULT true,
      sms_remind_customer BOOLEAN DEFAULT true,
      logo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('   ✅ companies table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      email TEXT,
      preferred_date TEXT,
      preferred_date_end TEXT,
      preferred_time TEXT,
      availability_type TEXT DEFAULT 'specific',
      service_requested TEXT,
      status TEXT DEFAULT 'Ny',
      price REAL,
      paid INTEGER DEFAULT 0,
      montour_name TEXT,
      comment TEXT,
      industry_data TEXT DEFAULT '{}',
      audio_url TEXT,
      image_url TEXT,
      call_count INTEGER DEFAULT 0,
      postal_code TEXT,
      cancelled INTEGER DEFAULT 0,
      cancelled_at TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('   ✅ customers table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      company_id INTEGER REFERENCES companies(id),
      twilio_call_sid TEXT,
      duration_seconds INTEGER,
      transcript TEXT,
      audio_url TEXT,
      status TEXT DEFAULT 'in-progress',
      call_outcome TEXT DEFAULT 'unknown',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('   ✅ calls table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      recipient_type TEXT,
      recipient_phone TEXT,
      message_body TEXT,
      message_type TEXT DEFAULT 'sms',
      twilio_sid TEXT,
      status TEXT DEFAULT 'sent',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('   ✅ messages table');

  // v3.9.54: self_healed_at column for calls
  await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS self_healed_at TIMESTAMP`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY,
      call_sid TEXT,
      company_id INTEGER,
      state TEXT DEFAULT 'greeting',
      collected_data TEXT DEFAULT '{}',
      conversation_history TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('   ✅ call_sessions table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coe_prompt_improvements (
      id SERIAL PRIMARY KEY,
      call_id INTEGER,
      company_id INTEGER,
      improvement_type TEXT DEFAULT 'generell',
      title TEXT,
      description TEXT,
      old_behavior TEXT DEFAULT '',
      new_behavior TEXT DEFAULT '',
      severity TEXT DEFAULT 'viktig',
      overall_note TEXT DEFAULT '',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('   ✅ coe_prompt_improvements table');

  // ===== Migrate existing tables (add new columns if missing) =====
  const migrations = [
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS boss_phone TEXT',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS boss_email TEXT',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_outcome TEXT DEFAULT \'unknown\'',
    // Set montour_phone for Samlekroken if missing
    "UPDATE companies SET montour_phone = '+4797479157' WHERE id = 1 AND (montour_phone IS NULL OR montour_phone = '')",
    // Availability management columns
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS availability_json TEXT DEFAULT \'[]\'',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS excluded_dates TEXT DEFAULT \'[]\'',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS reminder_sent TEXT DEFAULT \'[]\'',
    // Error flag for calls that had issues
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS error_flag BOOLEAN DEFAULT false',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS error_details TEXT',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS error_flag BOOLEAN DEFAULT false',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS error_details TEXT',
    // Session tracking for retry and customer linking
    'ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS customer_id INTEGER',
    'ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS no_input_count INTEGER DEFAULT 0',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS analysis_json TEXT DEFAULT \'{}\'',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS sms_notify_worker BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS sms_confirm_customer BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS sms_remind_customer BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT',
    // Worker approval flow
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS requires_worker_approval BOOLEAN DEFAULT false',
    // Uttrekk-SMS til ansatt (AI-oppsummering av samtale)
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS sms_extract_employee BOOLEAN DEFAULT true',
    // Kilde-merking for kunder
    "ALTER TABLE customers ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'Telefon'",
    // Call duration + outcome tracking for hangups
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_duration INTEGER DEFAULT 0',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_outcome TEXT',
    // Customer confirmation tracking
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS full_audio_transcript TEXT',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS extracted_info TEXT DEFAULT \'{}\'',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_quality TEXT DEFAULT \'unknown\'',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS confirmation_status TEXT DEFAULT \'pending\'',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS confirmed_by TEXT',
    // Messages table — SMS logging improvements
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS company_id INTEGER',
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT \'twilio\'',
    // v3.9.53 — Feature toggles per company
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS feature_phone BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS feature_chatbot BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS feature_calendar BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS feature_messages BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS feature_base44 BOOLEAN DEFAULT true',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS feature_inbound_sms BOOLEAN DEFAULT false',
    // v3.9.53 — Messages table: direction + phone_to for inbound SMS tracking
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT \'outbound\'',
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT',
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS phone_to TEXT',
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_id INTEGER',
    'ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP',
    // v3.9.74 — Multi-booking + employee assignment
    'ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assigned_to TEXT',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_to TEXT',
    'ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_concurrent_bookings INTEGER DEFAULT 5',
    // v3.9.73 — Login log for IP tracking
    `CREATE TABLE IF NOT EXISTS login_log (
      id SERIAL PRIMARY KEY,
      ip TEXT,
      success BOOLEAN DEFAULT false,
      company_name TEXT,
      is_admin BOOLEAN DEFAULT false,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    // v3.9.80 — Staff management per company
    `CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(20) NOT NULL DEFAULT '#6366f1',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    'ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_color TEXT',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS staff_color TEXT',
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch(e) { /* column may already exist */ }
  }
  console.log('   ✅ migrations done');

  // ===== Seed Data =====
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM companies');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO companies (name, industry, phone, greeting, montour_phone, login_password)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'Tom Bjørkhaugs Samlekrok',
        'antikviteter',
        '+12602612731',
        'God dag, du snakker nå med Tom Bjørkhaugs Samlekrok sin KI-assistent. Det vil bli gjort opptak av samtalen for utviklingsformål. Hva kan jeg hjelpe deg med i dag?',
        null,
        'Sam#Kr0k!24vR'
      ]
    );
    console.log('✅ Seed: Tom Bjørkhaugs Samlekrok oppretta med passord');
  }

  // Seed Miocat staff (company_id=4) if not already seeded
  try {
    const staffCheck = await pool.query('SELECT COUNT(*) as count FROM staff WHERE company_id = 4');
    if (parseInt(staffCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO staff (company_id, name, color, is_active) VALUES
        (4, 'Ann-Louise', '#f87171', true),
        (4, 'Anne', '#60a5fa', true),
        (4, 'Beathe', '#fbbf24', true),
        (4, 'Janne', '#a3e635', true),
        (4, 'Mio Cathrine', '#34d399', true)
      `);
      console.log('✅ Seed: Miocat staff oppretta');
    }
  } catch(e) { console.log('⚠️ Staff seed skipped (table may not exist yet):', e.message); }

  console.log('✅ PostgreSQL database fully initialized!');
}

module.exports = { db, pool, initDatabase };

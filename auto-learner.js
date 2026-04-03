// ===== AUTO-LÆRINGS-SYSTEM =====
// Etter hver samtale: les analyse → generer forbedringer → lagr i DB → neste samtale bruker dem
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Kjører auto-forbedring etter en samtale
 * @param {object} pool - PostgreSQL pool
 * @param {number} callId - ID for samtalen
 * @param {number} companyId - Selskaps-ID
 * @param {string} transcript - Full samtalelogg
 * @param {object} analysis - Analyse-JSON fra call-analyzer
 */
async function autoImproveFromCall(pool, callId, companyId, transcript, analysis) {
  try {
    if (!analysis || !transcript) {
      console.log('[AUTO-LEARN] Mangler analyse eller transkripsjon, hopper over');
      return null;
    }

    // Get current active improvements to avoid duplicates
    const existingRes = await pool.query(
      'SELECT description FROM coe_prompt_improvements WHERE company_id = $1 AND active = true',
      [companyId]
    );
    const existingImprovements = existingRes.rows.map(r => r.description);

    const prompt = `Du er en AI-system-optimerer. Basert på denne samtaleanalysen, generer KONKRETE forbedringer som kan legges til i AI-prompten for å unngå de samme feilene igjen.

SAMTALE-TRANSKRIPSJON:
${transcript.substring(0, 3000)}

ANALYSE:
${JSON.stringify(analysis, null, 2)}

ALLEREDE AKTIVE FORBEDRINGER (ikke gjenta disse):
${existingImprovements.map(e => '- ' + e).join('\n') || 'Ingen ennå'}

REGLER:
- Lag KUN forbedringer som er KONKRETE og HANDLINGSRETTEDE
- Hver forbedring er en kort instruks AI-en kan følge direkte
- Maks 3 forbedringer per samtale
- Skriv på norsk bokmål
- Fokuser på de viktigste feilene
- Ikke gjenta forbedringer som allerede er aktive
- Hvis samtalen var perfekt (score 8+), returner tomt array

Returner JSON:
{
  "improvements": [
    {
      "type": "feil_fikset|ny_regel|bedre_formulering|manglende_oppfølging",
      "title": "Kort tittel (maks 50 tegn)",
      "description": "Konkret instruks AI-en skal følge (maks 150 tegn)",
      "old_behavior": "Hva AI-en gjorde feil",
      "new_behavior": "Hva AI-en skal gjøre i stedet",
      "severity": "kritisk|viktig|mindre"
    }
  ],
  "overall_note": "Kort oppsummering av forbedringene (vises i CRM)"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 800,
    });

    const result = JSON.parse(response.choices[0].message.content);
    
    if (!result.improvements || result.improvements.length === 0) {
      console.log('[AUTO-LEARN] Ingen forbedringer nødvendig for samtale', callId);
      // Still save a record that analysis was done
      await pool.query(
        `INSERT INTO coe_prompt_improvements (call_id, company_id, improvement_type, title, description, old_behavior, new_behavior, severity, overall_note, active)
         VALUES ($1, $2, 'ingen', 'Ingen forbedringer nødvendig', 'Samtalen var god nok', '', '', 'ingen', $3, false)`,
        [callId, companyId, result.overall_note || 'Ingen forbedringer trengs']
      );
      return result;
    }

    // Save each improvement to DB
    for (const imp of result.improvements) {
      await pool.query(
        `INSERT INTO coe_prompt_improvements (call_id, company_id, improvement_type, title, description, old_behavior, new_behavior, severity, overall_note, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [callId, companyId, imp.type, imp.title, imp.description, imp.old_behavior || '', imp.new_behavior || '', imp.severity || 'viktig', result.overall_note || '']
      );
    }

    console.log(`[AUTO-LEARN] ${result.improvements.length} forbedringer lagret for samtale ${callId}`);
    return result;
  } catch (error) {
    console.error('[AUTO-LEARN] Feil:', error.message);
    return null;
  }
}

/**
 * Henter alle aktive forbedringer for et selskap — brukes i AI-prompten
 */
async function getActiveImprovements(pool, companyId) {
  try {
    const res = await pool.query(
      `SELECT description, improvement_type, severity FROM coe_prompt_improvements 
       WHERE company_id = $1 AND active = true 
       ORDER BY severity DESC, created_at DESC 
       LIMIT 20`,
      [companyId]
    );
    return res.rows;
  } catch (error) {
    console.error('[AUTO-LEARN] Feil ved henting av forbedringer:', error.message);
    return [];
  }
}

/**
 * Henter forbedringer for en spesifikk samtale — brukes i CRM
 */
async function getImprovementsForCall(pool, callId) {
  try {
    const res = await pool.query(
      `SELECT * FROM coe_prompt_improvements WHERE call_id = $1 ORDER BY created_at ASC`,
      [callId]
    );
    return res.rows;
  } catch (error) {
    console.error('[AUTO-LEARN] Feil ved henting:', error.message);
    return [];
  }
}

/**
 * Deaktiver en forbedring
 */
async function deactivateImprovement(pool, improvementId) {
  try {
    await pool.query('UPDATE coe_prompt_improvements SET active = false WHERE id = $1', [improvementId]);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = { autoImproveFromCall, getActiveImprovements, getImprovementsForCall, deactivateImprovement };

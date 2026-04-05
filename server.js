// ===== COE AI VOICE ASSISTANT - MAIN SERVER (v3.9.64 — OpenAI Realtime) =====
// Express server with Twilio webhooks for voice and SMS

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { db, pool, initDatabase } = require('./db');
const { processMessage, verifyCollectedData } = require('./ai-conversation');
const { autoImproveFromCall, getActiveImprovements, getImprovementsForCall, deactivateImprovement } = require('./auto-learner');
const { sendToMontour, sendToCustomer, sendBookingConfirmation, sendExtractionSms, handleIncomingSms, forwardImageToMontour, startReminderScheduler, parseAvailabilityText, sendErrorAlert } = require('./sms-handler');
// speech-hints.js available for future use — inline hints in gatherCustomerSpeech for reliability
const { smartVerify, verifyCustomerData } = require('./registry-lookup');
const { startHealthMonitor, runHealthCheck, getDetailedStatus } = require('./health-monitor');
const { initSecurityTables, securityMiddleware, startSecurityCrons, setupSecurityRoutes, runSecurityAudit } = require('./security-monitor');
const { initCostTables, runDailyCostCheck, startCostMonitor } = require('./cost-monitor');
const monitoring = require('./monitoring');

// ===== FELLES BASE-PROMPT FOR ALLE VAPI-ASSISTENTER =====
function buildVapiBasePrompt(company) {
  // Beregn dagens dato og 3-måneders kalender
  const now = new Date();
  const dayNames = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
  const dayShort = ['søn','man','tir','ons','tor','fre','lør'];
  const monthNames = ['januar','februar','mars','april','mai','juni','juli','august','september','oktober','november','desember'];
  const todayStr = `${dayNames[now.getDay()]} ${now.getDate()}. ${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  
  // Kompakt 3-måneders kalender
  let calendar = [];
  let currentWeek = [];
  let currentMonth = '';
  for (let i = 0; i < 90; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const month = monthNames[d.getMonth()];
    if (month !== currentMonth) {
      if (currentWeek.length > 0) { calendar.push(currentWeek.join(' ')); currentWeek = []; }
      currentMonth = month;
      calendar.push(`--- ${month.toUpperCase()} ${d.getFullYear()} ---`);
    }
    currentWeek.push(`${dayShort[d.getDay()]}${d.getDate()}`);
    if (d.getDay() === 0 || i === 89) {
      calendar.push(currentWeek.join(' '));
      currentWeek = [];
    }
  }
  
  return `Du er K.I.-assistent for ${company.name}. 100% norsk bokmål. ALDRI et eneste engelsk ord.

I DAG: ${todayStr}
KALENDER:\n${calendar.join('\\n')}

SPRÅKKRAV — ABSOLUTT:
- HELE samtalen på norsk bokmål. Absolutt NULL engelske ord eller uttrykk.
- FORBUDTE fraser: "just a sec", "one moment", "hold on", "let me check", "this will just take a second", "transferring", "goodbye", "sure", "alright", "okay so". ALDRI bruk disse.
- Bruk "Et øyeblikk" når du sjekker noe. "Ha det bra" ved avslutning.
- Bekreftelser: "Flott", "Fint", "Supert", "Da noterer jeg det". ALDRI engelske varianter.

SAMTALEFLYT (hopp over besvarte steg):
1. Behov — hva trenger kunden?
2. Navn — "Hva er navnet ditt?" → gjenta: "Da har jeg [navn], stemmer det?"
3. Oppfølgingsspørsmål om behov (meny, antall, levering etc.)
4. Dato — "Hvilken dato?" → si "Et øyeblikk" → kall check_availability → fortell kunden hvilke tider som er LEDIGE den dagen: "Den dagen har vi ledig kl X, Y og Z." Om ingen ledige: "Den dagen er dessverre full. Hva med [nærmeste ledige dag]?"
${company.requires_worker_approval === false ? 
`5. Klokkeslett — basert på ledige tider fra check_availability, spør: "Hvilket av disse klokkeslettene passer best?" (MÅ ha eksakt tid som faktisk er ledig)` :
`5. Tidsrom — "Har du et bestemt tidsrom?" (formiddag/ettermiddag)`}
6. Adresse + postnummer (IKKE for frisør/salong)
${company.requires_worker_approval === false ?
`7. AVSLUTT: "Da er du booket [dato] kl [tid]. Du får bekreftelse på SMS. Ha en fin dag!"` :
`7. AVSLUTT: "Vi kommer tilbake TIL DEG med bekreftelse. Ha en fin dag!"`}

REGLER:
- Bekreft kort + neste spørsmål UMIDDELBART. Aldri frys. Aldri stille.
- Kunden sier "henter selv" → noter HENTER SELV. Kunden sier "levering" → noter LEVERING. ALDRI si det motsatte av hva kunden sa.
- DATO: "24. desember 2027" = 24. desember 2027. Bruk ALLTID kundens årstall. ALDRI endre til ${now.getFullYear()}. Fire siffer etter måned = årstall, IKKE klokkeslett.
- KLOKKESLETT: Kun når du SPESIFIKT spør om klokkeslett. "Klokka tolv" = 12:00. "Halv tre" = 14:30.
- NAVN: Gjenta ÉN gang. Kunden korrigerer → bruk ny versjon uten å spørre igjen. ALDRI loop.
- ADRESSE: Skriv NØYAKTIG det kunden sier. Bruk validate_address. Maks 5 forsøk. Aldri gi opp og transfer.
- La kunden snakke ferdig. ALDRI avbryt.
- Aldri spør om telefonnummer.
- transferCall BARE når kunden EKSPLISITT sier "kan jeg snakke med noen" eller lignende. ALDRI transfer fordi du ikke forstår — spør heller på nytt.
- Hilsen er allerede sagt. ALDRI gjenta.
- "Et øyeblikk" før function calls. Fortsett umiddelbart etter.
`;
}


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security middleware — login logging + brute-force protection
app.use(securityMiddleware(db));

// Serve CRM static files
app.use('/crm', express.static(path.join(__dirname, 'public')));

// Redirect /crm to /crm/ for proper static serving
app.get('/crm', (req, res) => res.redirect('/crm/'));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  'https://backend-production-6779.up.railway.app';

// NOTE: Speech hints removed — Whisper handles Norwegian natively with its prompt parameter

// ===== IMPROVEMENTS CACHE (avoid DB query every turn) =====
const improvementsCache = new Map(); // companyId → { data, timestamp }
const CACHE_TTL = 120000; // 2 minutes

// === SMS RATE LIMITER (prevents Twilio 63038 spam) ===
const smsRateLimit = { count: 0, date: new Date().toDateString(), maxPerDay: 250, blocked: false };
function canSendSMS() {
  const today = new Date().toDateString();
  if (smsRateLimit.date !== today) { smsRateLimit.count = 0; smsRateLimit.date = today; smsRateLimit.blocked = false; }
  if (smsRateLimit.count >= smsRateLimit.maxPerDay) {
    if (!smsRateLimit.blocked) { console.log(`⚠️ SMS daglig grense nådd (${smsRateLimit.maxPerDay}) — stopper SMS til i morgen`); smsRateLimit.blocked = true; }
    return false;
  }
  return true;
}
function trackSMSSent() { smsRateLimit.count++; console.log(`📊 SMS sendt i dag: ${smsRateLimit.count}/${smsRateLimit.maxPerDay}`); }
// Also deduplicate: track which call IDs already got SMS
const smsSentForCall = new Set();

async function getCachedImprovements(companyId) {
  const cached = improvementsCache.get(companyId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  const improvements = pool ? await getActiveImprovements(pool, companyId) : [];
  improvementsCache.set(companyId, { data: improvements, timestamp: Date.now() });
  return improvements;
}

// ===== Natural TTS with Polly.Liv-Neural =====
function naturalSay(twiml, text) {
  // Polly.Liv = Norwegian female voice — SSML prosody for slower, clearer speech (90% speed)
  const say = twiml.say({ voice: 'Polly.Liv' });
  say.prosody({ rate: '90%' }, text);
}

// Helper: escape XML special characters
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ===== STATE-AWARE SPEECH HINTS (better recognition based on what we're collecting) =====
const BASE_HINTS = [
  'æ,eg,ikkje,ittj,ke,mæ,dæ,sæ,golv,mykje,nokke,kossen,korsn,kordan,åssen,kvifor,korfor,å nei,jau,ja vel,heim,heime,berre,bere,litt,litte,sku,ska,vil,vill,kann,kan,sei,fortell,nåkke',
  'ja,nei,jo,jau,jepp,javisst,absolutt,akkurat,nettopp,selvfølgelig,klart,greit,ok,okei,det stemmer,riktig,niks,ikke,aldri',
  'hei,hallo,god dag,morn,heisann,takk,tusen takk,ha det,ha det bra,adjø,fint,flott,supert,bra,kjempebra',
  'jeg vil,jeg ønsker,jeg trenger,jeg lurer på,kan dere,har dere,hva koster,hvor mye,når kan,jeg har,jeg bor,jeg heter',
  'bestille,time,avtale,befaring,vurdering,reparasjon,kjøpe,selge,levere,hente,maling,elektriker,rørlegger,frisør,antikviteter',
  'kniv,kniver,skap,møbel,bord,stol,kommode,speil,maleri,lampe,ur,klokke,sølvtøy,porselen,smykke,ring,armbånd,mynter,bøker'
];

const NAME_HINTS = [
  'Tobias,Gunnhild,Bjørn,Kari,Ola,Per,Lars,Anne,Erik,Hilde,Sigrid,Ingrid,Astrid,Magnus,Tor,Terje,Randi,Silje,Marit,Trond,Geir,Liv,Morten,Svein,Harald,Kristin,Solveig,Bente,Inger,Jan,Gunnar,Odd,Rolf,Jostein,Arne,Frode,Håkon,Espen,Stian,Vegard,Nils,Olav,Ragnar,Stig,Vidar,Wenche,Turid,Berit,Unni,Gunn,Dagny,Arvid,Leif,Steinar,Kjell,Ivar,Øyvind,Roar,Tore,Amund,Egil,Hallvard,Asbjørn,Torbjørn,Lea,Tom,Maria,Nina,Hanna,Siri,Grete,Else,Ruth,Tone,Line,Mona,Eva,Ida,Lisa,Sara,Emma,Nora,Sofie,Julie,Thea,Amalie,Emilie',
  'Bjørkhaug,Blakarstugun,Hansen,Johansen,Olsen,Larsen,Andersen,Pedersen,Nilsen,Kristiansen,Jensen,Karlsen,Johnsen,Pettersen,Eriksen,Berg,Haugen,Hagen,Johannessen,Jacobsen,Dahl,Halvorsen,Henriksen,Lund,Sørensen,Moen,Gundersen,Strand,Bakke,Holm,Solheim,Nygård,Eide,Berge,Brekke,Myhre,Svendsen,Tangen,Arnesen,Skoglund,Nordby,Lie,Vik,Bakken,Martinsen,Lien,Hauge,Knutsen,Ruud',
  'jeg heter,navnet mitt er,det er,heier,heter,fornavnet,etternavnet'
];

const ADDRESS_HINTS = [
  'gata,veien,vegen,gate,vei,veg,plass,stien,allé,alle,torget,tunet,haugen,bakken,lia,åsen,sletta,jordet,engen,svingen,kroken,løkka',
  'Storgata,Kirkegata,Kongens gate,Karl Johans gate,Grünerløkka,Torggata,Markveien,Trondheimsveien,Bogstadveien,Majorstuen,Frogner,Grønland,Bygdøy,Holmenkollen,Sagene,Aker Brygge,Bryggen,Nygårdsgaten,Olav Tryggvasons gate,Munkegata,Fjordgata,Nordre gate,Søndre gate,Prinsens gate,Dronningens gate',
  'Oslo,Bergen,Trondheim,Stavanger,Drammen,Fredrikstad,Kristiansand,Tromsø,Sandnes,Sarpsborg,Skien,Bodø,Ålesund,Sandefjord,Haugesund,Moss,Arendal,Tønsberg,Hamar,Halden,Larvik,Kongsberg,Molde,Harstad,Lillehammer,Gjøvik,Hønefoss,Elverum,Steinkjer,Namsos,Mo i Rana,Narvik,Alta,Hammerfest,Kirkenes,Grimstad,Mandal,Notodden,Kongsvinger,Otta,Vinstra,Fagernes,Voss,Stord,Førde,Florø,Volda,Kristiansund',
  'null,en,to,tre,fire,fem,seks,sju,syv,åtte,ni,ti,elleve,tolv,tjue,tretti,førti,femti,seksti,sytti,åtti,nitti,hundre',
  'adressen min er,jeg bor i,bor på,bor i'
];

const DATE_TIME_HINTS = [
  'klokka,klokken,halv,kvart over,kvart på,ti over,ti på,ett,to,tre,fire,fem,seks,sju,syv,åtte,ni,ti,elleve,tolv,tretten,fjorten,femten,seksten,sytten,atten,nitten,tjue,hele dagen,formiddag,ettermiddag,morgen,kveld,etter jobb,rundt lunsj,på morgenen,tidlig,sent',
  'mandag,tirsdag,onsdag,torsdag,fredag,lørdag,søndag,neste uke,denne uka,i morgen,i overmorgen,neste mandag,neste tirsdag,neste onsdag,neste torsdag,neste fredag,januar,februar,mars,april,mai,juni,juli,august,september,oktober,november,desember',
  'når som helst,passer bra,den datoen,den dagen,hele dagen,om morgenen,på ettermiddagen,på kvelden'
];

const PHONE_HINTS = [
  'null,en,to,tre,fire,fem,seks,sju,syv,åtte,ni,ti',
  'nummeret mitt er,telefonen min er,du kan nå meg på,ring meg på'
];

function getHintsForState(collectedData) {
  const hints = [...BASE_HINTS];
  const d = collectedData || {};
  
  // Always include some of everything, but PRIORITIZE what we're collecting next
  if (!d.problem) {
    // Collecting need/problem — broad hints
    hints.push(...NAME_HINTS, ...ADDRESS_HINTS.slice(0, 2));
  } else if (!d.navn) {
    // Collecting name — heavy name hints
    hints.push(...NAME_HINTS);
    hints.push(...ADDRESS_HINTS.slice(0, 1));
  } else if (!d.adresse) {
    // Collecting address — heavy address hints
    hints.push(...ADDRESS_HINTS);
    hints.push(...NAME_HINTS.slice(0, 1));
  } else if (!d.dato || !d.klokkeslett) {
    // Collecting date/time
    hints.push(...DATE_TIME_HINTS);
  } else {
    // All collected — general hints
    hints.push(...NAME_HINTS.slice(0, 1), ...ADDRESS_HINTS.slice(0, 2), ...DATE_TIME_HINTS.slice(0, 1));
  }
  
  return hints.join(',');
}

// ===== Gather customer speech (fast inline STT) =====
function gatherCustomerSpeech(twiml, actionUrl, collectedData) {
  const gather = twiml.gather({
    input: 'speech',
    language: 'no-NO',
    speechModel: 'experimental_conversations',
    speechTimeout: 1,
    action: actionUrl,
    method: 'POST',
    hints: getHintsForState(collectedData),
  });
  const separator = actionUrl.includes('?') ? '&' : '?';
  twiml.redirect(`${actionUrl}${separator}noInput=1`);
}

// ===== Transcribe audio with OpenAI Whisper =====
async function transcribeWithWhisper(recordingUrl, recordingSid, companyContext) {
  const audioUrl = `${recordingUrl}.mp3`;
  
  // Download recording from Twilio (requires auth)
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');
  
  // Retry download up to 3 times (recording may not be ready immediately)
  let audioBuffer;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(audioUrl, { headers: { 'Authorization': authHeader } });
      if (response.ok) {
        audioBuffer = Buffer.from(await response.arrayBuffer());
        break;
      }
      console.log(`⏳ Recording not ready yet (attempt ${attempt}/3), waiting...`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    } catch (err) {
      console.log(`⏳ Download attempt ${attempt}/3 failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  
  if (!audioBuffer || audioBuffer.length < 100) {
    throw new Error('Could not download recording from Twilio');
  }
  
  // Write to temp file for Whisper API
  const tmpPath = `/tmp/whisper_${recordingSid || Date.now()}.mp3`;
  fs.writeFileSync(tmpPath, audioBuffer);
  
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'no',  // Norwegian — Whisper is excellent at this!
      prompt: `Norsk telefonsamtale med ${companyContext || 'et norsk selskap'}. Kunden oppgir sitt navn, adresse, telefonnummer og dato. Vanlige norske navn, gateadresser og byer. Tall er telefonnumre med 8 siffer.`,
    });
    console.log(`🎤 Whisper transcription: "${transcription.text}"`);
    return transcription.text;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch(e) {} // Clean up temp file
  }
}

// ===== Transcribe FULL recording + extract customer info =====
async function transcribeFullRecording(audioUrl, callId) {
  try {
    // Detect if Vapi or Twilio URL
    const isVapi = audioUrl.includes('storage.vapi.ai') || audioUrl.includes('vapi');
    const fullUrl = isVapi ? audioUrl : `${audioUrl}.mp3`;
    const headers = {};
    if (!isVapi) {
      headers['Authorization'] = 'Basic ' + Buffer.from(
        `${process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN}`
      ).toString('base64');
    }
    
    // Download recording
    let response;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        response = await fetch(fullUrl, { headers });
        if (response.ok) break;
      } catch(e) {}
      if (attempt < 5) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
    if (!response || !response.ok) {
      console.error(`❌ Kunne ikke laste ned opptak for full transkripsjon (${isVapi?'Vapi':'Twilio'}): ${response?.status}`);
      return null;
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    const tmpPath = `/tmp/full_transcript_${callId}_${Date.now()}.mp3`;
    fs.writeFileSync(tmpPath, buffer);
    
    // Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'no',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });
    
    const fullText = transcription.text;
    console.log(`📝 Full transkripsjon (${fullText.length} tegn) for call ${callId}`);
    
    // Save full transcript to call — also update main transcript and quality
    await db.run('UPDATE calls SET full_audio_transcript = $1, transcript = CASE WHEN transcript_quality = \'garbage\' OR transcript IS NULL OR LENGTH(transcript) < 50 THEN $1 ELSE transcript END, transcript_quality = \'whisper_recovered\' WHERE id = $2', fullText, callId);
    console.log(`✅ Whisper-transkript lagret for call ${callId}`);
    
    // Extract customer info with GPT-4o
    const extractedInfo = await extractInfoFromTranscript(fullText, callId);
    
    // Update extracted_info on call
    if (extractedInfo) {
      await db.run('UPDATE calls SET extracted_info = $1 WHERE id = $2', JSON.stringify(extractedInfo), callId);
      // Also update customer if we got a name
      const call = await db.get('SELECT customer_id FROM calls WHERE id = $1', callId);
      if (call?.customer_id && extractedInfo.navn) {
        const badNames = ['ny innringer','user','ukjent','unknown','test'];
        if (!badNames.includes((extractedInfo.navn||'').toLowerCase())) {
          await db.run(`UPDATE customers SET name = CASE WHEN name IN ('Ny innringer','User','user','Ukjent','unknown') THEN $1 ELSE name END WHERE id = $2`, extractedInfo.navn, call.customer_id);
          console.log(`✅ Kundenavn oppdatert: ${extractedInfo.navn}`);
        }
      }
    }
    
    fs.unlinkSync(tmpPath);
    return { transcript: fullText, extractedInfo };
  } catch(err) {
    console.error('❌ Full transkripsjon feilet:', err.message);
    return null;
  }
}

async function extractInfoFromTranscript(transcript, callId) {
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `Du er en informasjonsuttrekker. Analyser denne telefonsamtale-transkripsjonen og trekk ut all kundeinformasjon du finner. Returner et JSON-objekt med følgende felter (bruk null hvis ikke nevnt):
{
  "navn": "kundens fulle navn",
  "adresse": "gateadresse",
  "postnummer": "postnummer",
  "telefon": "telefonnummer",
  "epost": "e-postadresse",
  "behov": "hva kunden trenger / problemet",
  "dato": "ønsket dato (primær). Hvis flere datoer nevnt, sett primær her",
  "alternative_datoer": "eventuelle alternative datoer kunden nevnte (kommaseparert, eller null)",
  "klokkeslett": "ønsket tidspunkt/tidsrom",
  "tilgjengelighet": "når kunden er tilgjengelig — inkluder alle nevnte tidsrom per dato",
  "spesielle_behov": "allergier, barn, dyr, medisinske behov etc.",
  "prisforventning": "eventuell prisforventning nevnt",
  "hastegrad": "normal/haster/akutt",
  "ekstra_detaljer": "andre relevante detaljer fra samtalen",
  "ønsket_ansatt": "om kunden ønsker en bestemt ansatt/frisør/montør, eller 'Ingen preferanse'",
  "sammendrag": "kort oppsummering av samtalen på 1-2 setninger"
}
Svar KUN med JSON, ingen annen tekst.` },
        { role: 'user', content: transcript }
      ],
      temperature: 0.1
    });
    
    const infoText = extraction.choices[0].message.content.replace(/```json\n?|```/g, '').trim();
    const info = JSON.parse(infoText);
    
    // Save extracted info to call
    await db.run('UPDATE calls SET extracted_info = $1 WHERE id = $2', JSON.stringify(info), callId);
    
    // Auto-update customer fields if they're empty
    const call = await db.get('SELECT * FROM calls WHERE id = $1', callId);
    if (call && call.customer_id) {
      const customer = await db.get('SELECT * FROM customers WHERE id = $1', call.customer_id);
      if (customer) {
        const updates = [];
        const values = [];
        let paramIdx = 1;
        
        // Overwrite with extracted info (more complete from full transcript analysis)
        if (info.navn && info.navn !== 'null') { updates.push(`name = $${paramIdx++}`); values.push(info.navn); }
        if (info.adresse && info.adresse !== 'null') { updates.push(`address = $${paramIdx++}`); values.push(info.adresse); }
        if (info.postnummer && info.postnummer !== 'null') { updates.push(`postal_code = $${paramIdx++}`); values.push(info.postnummer); }
        if (info.telefon && info.telefon !== 'null') { updates.push(`phone = $${paramIdx++}`); values.push(info.telefon); }
        if (info.epost && info.epost !== 'null') { updates.push(`email = $${paramIdx++}`); values.push(info.epost); }
        if (info.behov && info.behov !== 'null') { updates.push(`service_requested = $${paramIdx++}`); values.push(info.behov); }
        if (info.dato && info.dato !== 'null') { updates.push(`preferred_date = $${paramIdx++}`); values.push(info.dato); }
        if (info.klokkeslett && info.klokkeslett !== 'null') { updates.push(`preferred_time = $${paramIdx++}`); values.push(info.klokkeslett); }
        if (info.ønsket_ansatt && info.ønsket_ansatt !== 'null') { updates.push(`montour_name = $${paramIdx++}`); values.push(info.ønsket_ansatt); }
        if (info.ekstra_detaljer && info.ekstra_detaljer !== 'null') { updates.push(`comment = $${paramIdx++}`); values.push(info.ekstra_detaljer); }
        
        if (updates.length > 0) {
          values.push(call.customer_id);
          await db.run(`UPDATE customers SET ${updates.join(', ')} WHERE id = $${paramIdx}`, ...values);
          console.log(`✅ Auto-oppdaterte ${updates.length} felt for kunde ${call.customer_id} fra transkripsjon`);
        }
      }
    }
    
    // Verify address against Kartverket registry
    if (info.adresse && call && call.customer_id) {
      try {
        const verified = await smartVerify(info.adresse);
        if (verified) {
          console.log(`✅ [REGISTRY] Transcript verify: "${info.adresse}" → "${verified.type === 'address' ? verified.full : verified.name}"`);
          const verifiedAddr = verified.type === 'address' ? verified.full : verified.name;
          const verifiedPostalCode = verified.postalCode || null;
          const regUpdates = [`address = $1`];
          const regValues = [verifiedAddr];
          let regIdx = 2;
          if (verifiedPostalCode) {
            regUpdates.push(`postal_code = $${regIdx++}`);
            regValues.push(verifiedPostalCode);
          }
          regValues.push(call.customer_id);
          await db.run(`UPDATE customers SET ${regUpdates.join(', ')} WHERE id = $${regIdx}`, ...regValues);
        }
      } catch (regErr) {
        console.error('[REGISTRY] Transcript verification failed:', regErr.message);
      }
    }

    console.log(`🔍 Info hentet ut fra transkripsjon for call ${callId}:`, info.sammendrag);
    return info;
  } catch(err) {
    console.error('❌ Info-uttrekk feilet:', err.message);
    return {};
  }
}


// ===============================================================
// KNOWN ISSUES — problemsporing per selskap
// ===============================================================
app.get('/api/company/:id/issues', async (req, res) => {
  try {
    const company = await db.get('SELECT known_issues, ai_version FROM companies WHERE id = $1', req.params.id);
    if (!company) return res.status(404).json({ error: 'Selskap ikke funnet' });
    res.json({ 
      issues: JSON.parse(company.known_issues || '[]'),
      ai_version: company.ai_version || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/company/:id/issues', async (req, res) => {
  try {
    const { issues } = req.body;
    await db.run('UPDATE companies SET known_issues = $1 WHERE id = $2', JSON.stringify(issues), req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===============================================================
// HEALTH CHECK — self-monitoring, no external dependency
// ===============================================================
app.get('/health', async (req, res) => {
  try {
    // Quick DB ping to verify actual connectivity
    const dbStart = Date.now();
    const dbCheck = await db.get('SELECT 1 as ok');
    const dbLatency = Date.now() - dbStart;
    
    res.json({ 
      status: dbCheck ? 'ok' : 'error',
      timestamp: new Date().toISOString(), 
      version: '3.9.59',
      uptime: Math.round(process.uptime()),
      dbLatency,
      env: {
        openai: !!process.env.OPENAI_API_KEY,
        twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
        twilio_token: !!process.env.TWILIO_AUTH_TOKEN,
        twilio_api_key: !!process.env.TWILIO_API_KEY_SID,
        database: !!process.env.DATABASE_URL
      }
    });
  } catch (err) {
    res.status(503).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      version: '3.9.59',
      error: err.message 
    });
  }
});

// Detailed health — full diagnostics dashboard
app.get('/health/detailed', async (req, res) => {
  try {
    const liveCheck = await runHealthCheck(db);
    const detailed = getDetailedStatus();
    res.json({ ...detailed, liveCheck });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ===============================================================
// 1. INCOMING VOICE CALL - Twilio webhook
// ===============================================================
app.post('/twilio/voice', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const from = req.body.From;
    
    console.log(`📞 Incoming call from ${from}, SID: ${callSid}`);

    // Find company by the called number
    const calledNumber = req.body.To;
    const company = await db.get('SELECT * FROM companies WHERE phone = $1', calledNumber);

    if (!company) {
      console.log('⚠️ No company found for number:', calledNumber);
      const twiml = new VoiceResponse();
      naturalSay(twiml, 'Beklager, dette nummeret er ikke konfigurert. Ha en fin dag!');
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // Check if returning customer
    const existingCustomer = await db.get(
      'SELECT * FROM customers WHERE phone = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1',
      from, company.id
    );

    let greetingText = company.greeting;
    // NEVER personalize greeting with customer name - just use company greeting
    // (Previous calls may have stored wrong name from STT errors)

    // Create partial customer immediately — so we always have a record + audio link
    const customerResult = await db.run(
      `INSERT INTO customers (company_id, name, phone, status, source) VALUES ($1, 'Ny innringer', $2, 'Ny', 'Telefon') RETURNING id`,
      company.id, from || 'Ukjent'
    );
    const customerId = customerResult.rows[0].id;

    // Create session with customer link
    const sessionId = uuidv4();
    await db.run(`INSERT INTO call_sessions (id, call_sid, company_id, state, customer_id, collected_data) VALUES ($1, $2, $3, 'greeting', $4, $5)`,
      sessionId, callSid, company.id, customerId, JSON.stringify({ telefon: from || '' }));

    // Log the call — linked to customer from the start
    await db.run(`INSERT INTO calls (company_id, customer_id, twilio_call_sid, status) VALUES ($1, $2, $3, 'in-progress')`,
      company.id, customerId, callSid);

    // Build TwiML response
    const twiml = new VoiceResponse();

    // Start call recording via REST API (runs in background, doesn't block TwiML)
    try {
      const twilioClient = require('twilio')(process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN, { accountSid: process.env.TWILIO_ACCOUNT_SID });
      twilioClient.calls(callSid).recordings.create({
        recordingStatusCallback: `${BASE_URL}/twilio/recording`,
        recordingStatusCallbackMethod: 'POST',
        recordingChannels: 'dual',
      }).then(rec => console.log(`🎙️ Recording started: ${rec.sid}`))
        .catch(err => console.error('⚠️ Recording start failed:', err.message));
    } catch (recErr) {
      console.error('⚠️ Could not start recording:', recErr.message);
    }

    // Greet the customer first, then record their response
    naturalSay(twiml, greetingText);
    
    // Record customer speech (Whisper will transcribe — much better than Twilio STT!)
    gatherCustomerSpeech(twiml, `${BASE_URL}/twilio/voice/respond?sessionId=${sessionId}`);

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('🚨 CRITICAL ERROR in /twilio/voice:', err.message, err.stack);
    // NEVER crash — always return valid TwiML so the caller hears something
    const twiml = new VoiceResponse();
    naturalSay(twiml, 'Beklager, vi opplever tekniske problemer akkurat nå. Vennligst prøv igjen om et øyeblikk, eller ring oss direkte. Ha en fin dag!');
    res.type('text/xml').send(twiml.toString());
    
    // Send alert (async, don't block response)
    sendErrorAlert(null, req.body?.CallSid, err.message, req.body?.From).catch(() => {});
  }
});

// ===============================================================
// 2. VOICE CONVERSATION LOOP - Process speech and respond
// ===============================================================
app.post('/twilio/voice/respond', async (req, res) => {
  const sessionId = req.query.sessionId;
  let company = null;
  let session = null;
  
  try {
    // Gather sends SpeechResult directly (no recording download needed!)
    const speechResult = req.body.SpeechResult || '';
    const confidence = req.body.Confidence || 'N/A';
    const noInput = req.query.noInput === '1' || !speechResult.trim();

    // Detailed STT debug logging
    console.log(`📊 STT DEBUG — SpeechResult: "${speechResult}" | Confidence: ${confidence} | noInput: ${noInput}`);
    console.log(`📊 STT DEBUG — All Twilio params: ${JSON.stringify(req.body)}`);

    // SPEED: Single JOIN query instead of 2 separate queries
    const sessionRow = await db.get(`SELECT cs.*, co.id as comp_id, co.name as comp_name, co.industry as comp_industry, co.greeting as comp_greeting, co.montour_phone as comp_montour_phone, co.boss_phone as comp_boss_phone, co.phone as comp_phone, co.logo_url as comp_logo_url, co.sms_notify_worker as comp_sms_notify_worker, co.sms_confirm_customer as comp_sms_confirm_customer, co.sms_remind_customer as comp_sms_remind_customer, co.sms_extract_employee as comp_sms_extract_employee, co.system_prompt as comp_system_prompt, co.feature_auto_confirm as comp_feature_auto_confirm, co.feature_employee_alert as comp_feature_employee_alert, co.feature_info_out as comp_feature_info_out, co.address as comp_address FROM call_sessions cs JOIN companies co ON cs.company_id = co.id WHERE cs.id = $1`, sessionId);
    if (!sessionRow) {
      const twiml = new VoiceResponse();
      naturalSay(twiml, 'Beklager, det oppsto en teknisk feil. Kan du prøve å ringe igjen? Ha en fin dag!');
      res.type('text/xml').send(twiml.toString());
      return;
    }
    session = sessionRow;
    company = { id: sessionRow.comp_id, name: sessionRow.comp_name, industry: sessionRow.comp_industry, greeting: sessionRow.comp_greeting, montour_phone: sessionRow.comp_montour_phone, boss_phone: sessionRow.comp_boss_phone, phone: sessionRow.comp_phone, logo_url: sessionRow.comp_logo_url, sms_notify_worker: sessionRow.comp_sms_notify_worker, sms_confirm_customer: sessionRow.comp_sms_confirm_customer, sms_remind_customer: sessionRow.comp_sms_remind_customer, sms_extract_employee: sessionRow.comp_sms_extract_employee, system_prompt: sessionRow.comp_system_prompt, feature_auto_confirm: sessionRow.comp_feature_auto_confirm, feature_employee_alert: sessionRow.comp_feature_employee_alert, feature_info_out: sessionRow.comp_feature_info_out, address: sessionRow.comp_address };

    const twiml = new VoiceResponse();

    // ===== HANDLE NO INPUT — RETRY UP TO 3 TIMES =====
    if (noInput) {
      const retryCount = (session.no_input_count || 0) + 1;
      await db.run('UPDATE call_sessions SET no_input_count = $1 WHERE id = $2', retryCount, sessionId);

      if (retryCount >= 3) {
        naturalSay(twiml, 'Vi hørte dessverre ikke noe svar. Tusen takk for at du ringte. Ha en fin dag!');
        const noBookingTranscript = JSON.parse(session.conversation_history || '[]')
          .map(msg => `${msg.role === 'assistant' ? 'AI' : 'Kunde'}: ${msg.content}`)
          .join('\n');
        await db.run(`UPDATE calls SET call_outcome = 'no_booking', status = 'completed', transcript = $1 WHERE twilio_call_sid = $2`, 
          noBookingTranscript, session.call_sid);
        
        // Auto-analyse in background
        res.type('text/xml').send(twiml.toString());
        setImmediate(async () => {
          try {
            const CallAnalyzer = require('./call-analyzer');
            const analyzer = new CallAnalyzer(process.env.OPENAI_API_KEY);
            const analysis = await analyzer.analyzeSingleCall(noBookingTranscript, company?.name || 'Ukjent');
            if (analysis) {
              await db.run(`UPDATE calls SET analysis_json = $1 WHERE twilio_call_sid = $2`,
                JSON.stringify(analysis), session.call_sid);
              try {
                if (pool) {
                  const callRecord = await db.get('SELECT id FROM calls WHERE twilio_call_sid = $1', session.call_sid);
                  await autoImproveFromCall(pool, callRecord?.id || 0, company.id, noBookingTranscript, analysis);
                }
              } catch(e) {}
            }
          } catch(e) { console.error('⚠️ Auto-analyse feilet:', e.message); }

          // Uttrekk-SMS til montør/eier: de mister ikke leads selv uten bestilling
          try {
            if (noBookingTranscript && company.sms_extract_employee !== false && company.montour_phone) {
              await sendExtractionSms(noBookingTranscript, { name: session.customer_name || 'Ukjent innringer', phone: session.caller_phone || 'Ukjent' }, company);
              console.log(`📨 Uttrekk-SMS sendt for no-booking samtale ${session.call_sid}`);
            }
          } catch(e) { console.error('⚠️ No-booking uttrekk-SMS feilet:', e.message); }
        });
        return;
      }

      const retryMessages = [
        'Beklager, jeg hørte ikke helt hva du sa. Kan du gjenta?',
        'Jeg fikk dessverre ikke med meg det. Hva kan jeg hjelpe deg med?',
        'Er du der fortsatt? Hva kan jeg hjelpe deg med i dag?'
      ];
      naturalSay(twiml, retryMessages[retryCount - 1]);
      gatherCustomerSpeech(twiml, `${BASE_URL}/twilio/voice/respond?sessionId=${sessionId}`);
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // Reset no-input counter on successful speech (non-blocking)
    if (session.no_input_count > 0) {
      db.run('UPDATE call_sessions SET no_input_count = 0 WHERE id = $1', sessionId).catch(() => {});
    }

    // Load active improvements (CACHED — no DB query every turn!)
    const activeImprovements = await getCachedImprovements(company.id);

    // Process with AI (fast — gpt-4o-mini, no Whisper delay)
    const result = await processMessage(company, session, speechResult, activeImprovements);

    // ===== SPEED OPTIMIZATION: Send TwiML FIRST, then do all DB writes =====
    const data = result.collectedData || {};
    const customerId = session.customer_id;

    if (result.complete) {
      // Send response immediately — NO duplicate "kommer tilbake"
      naturalSay(twiml, result.response);
      res.type('text/xml').send(twiml.toString());

      // All post-processing in background (including session + customer DB writes)
      setImmediate(async () => {
        try {
          // Update session (moved here from blocking path)
          await db.run(`UPDATE call_sessions SET collected_data = $1, conversation_history = $2, state = 'complete' WHERE id = $3`,
            JSON.stringify(result.collectedData), JSON.stringify(result.conversationHistory), sessionId);

          // Update customer progressively
          if (customerId) {
            const cu = []; const cv = []; let ci = 1;
            if (data.navn) { cu.push(`name = $${ci++}`); cv.push(data.navn); }
            if (data.adresse) { cu.push(`address = $${ci++}`); cv.push(data.adresse); }
            if (data.telefon) { cu.push(`phone = $${ci++}`); cv.push(data.telefon); }
            if (data.dato) { cu.push(`preferred_date = $${ci++}`); cv.push(data.dato); }
            if (data.klokkeslett) { cu.push(`preferred_time = $${ci++}`); cv.push(data.klokkeslett); }
            const pm = (data.adresse || '').match(/\b(\d{4})\b/);
            if (pm) { cu.push(`postal_code = $${ci++}`); cv.push(pm[1]); }
            if (cu.length > 0) { cv.push(customerId); await db.run(`UPDATE customers SET ${cu.join(', ')} WHERE id = $${ci}`, ...cv); }
          }

          const industryFields = {};
          for (const [key, val] of Object.entries(data)) {
            if (!['navn', 'adresse', 'telefon', 'dato', 'klokkeslett'].includes(key)) {
              industryFields[key] = val;
            }
          }

          await db.run(`UPDATE customers SET status = 'Booket', service_requested = $1, industry_data = $2, comment = $3 WHERE id = $4`,
            result.summary || '', JSON.stringify(industryFields), result.summary || '', customerId);

          const availText = [data.dato, data.klokkeslett].filter(Boolean).join(' ');
          const availSlots = parseAvailabilityText(availText);
          if (availSlots.length > 0) {
            await db.run('UPDATE customers SET availability_json = $1 WHERE id = $2',
              JSON.stringify(availSlots), customerId);
          }

          const customer = await db.get('SELECT * FROM customers WHERE id = $1', customerId);

          // Verify address against Kartverket registry
          if (data.adresse) {
            try {
              const verified = await smartVerify(data.adresse);
              if (verified) {
                console.log(`✅ [REGISTRY] Verified: "${data.adresse}" → "${verified.type === 'address' ? verified.full : verified.name}"`);
                const verifiedAddress = verified.type === 'address' ? verified.full : verified.name;
                const verifiedPostal = verified.postalCode || null;
                const addrUpdates = [`address = $1`];
                const addrValues = [verifiedAddress];
                let addrIdx = 2;
                if (verifiedPostal) {
                  addrUpdates.push(`postal_code = $${addrIdx++}`);
                  addrValues.push(verifiedPostal);
                }
                addrValues.push(customerId);
                await db.run(`UPDATE customers SET ${addrUpdates.join(', ')} WHERE id = $${addrIdx}`, ...addrValues);
              } else {
                console.log(`⚠️ [REGISTRY] Could not verify address: "${data.adresse}"`);
              }
            } catch (regErr) {
              console.error('[REGISTRY] Verification failed:', regErr.message);
            }
          }

          const fullTranscript = result.conversationHistory
            .map(msg => `${msg.role === 'assistant' ? 'AI' : 'Kunde'}: ${msg.content}`)
            .join('\n');
          
          await db.run(`UPDATE calls SET status = 'completed', call_outcome = 'booking', transcript = $1 WHERE twilio_call_sid = $2`, 
            fullTranscript, session.call_sid);

          // Auto-analyse + auto-learn
          try {
            const CallAnalyzer = require('./call-analyzer');
            const analyzer = new CallAnalyzer(process.env.OPENAI_API_KEY);
            const analysis = await analyzer.analyzeSingleCall(fullTranscript, company.name);
            if (analysis) {
              await db.run(`UPDATE calls SET analysis_json = $1 WHERE twilio_call_sid = $2`,
                JSON.stringify(analysis), session.call_sid);
              try {
                if (pool) {
                  const callRecord = await db.get('SELECT id FROM calls WHERE twilio_call_sid = $1', session.call_sid);
                  await autoImproveFromCall(pool, callRecord?.id || 0, company.id, fullTranscript, analysis);
                }
              } catch(e) {}
            }
          } catch(e) { console.error('⚠️ Auto-analyse feilet:', e.message); }

          // SMS — uttrekk til ansatt
          await sendToMontour(customer, company);

          // SMS til kunde etter samtale
          if (customer?.phone) {
            try {
              const { sendSms } = require('./sms-handler');
              let smsMsg;
              
              if (company.requires_worker_approval === false) {
                // Autobekreftelse PÅ → bekreftelse-SMS med dato/tid/tjeneste
                const dateText = customer.preferred_date || data.dato || '';
                const timeText = customer.preferred_time || data.klokkeslett || '';
                const serviceText = customer.service_requested || data.tjeneste || '';
                let msg = `Hei${customer.name ? ' ' + customer.name.split(' ')[0] : ''}! Din bestilling hos ${company.name} er bekreftet.`;
                if (dateText) msg += `\n📅 Dato: ${dateText}`;
                if (timeText) msg += `\n🕐 Tid: ${timeText}`;
                if (serviceText) msg += `\n💼 Tjeneste: ${serviceText}`;
                if (company.address) msg += `\n📍 Adresse: ${company.address}`;
                msg += `\nVelkommen! 😊`;
                smsMsg = msg;
              } else {
                // Manuell bekreftelse → "Vi kommer tilbake TIL DEG"
                smsMsg = `Hei${customer.name ? ' ' + customer.name.split(' ')[0] : ''}! Takk for samtalen med ${company.name}. Vi kommer tilbake TIL DEG med bekreftelse. Ha en fin dag! 😊`;
              }
              
              const smsRes = await sendSms(customer.phone, smsMsg);
              if (smsRes?.sid) {
                const msgType = company.requires_worker_approval === false ? 'booking_confirmation' : 'auto_confirm';
                await db.query(`INSERT INTO messages (customer_id, recipient_type, recipient_phone, message_body, message_type, twilio_sid, status, created_at) VALUES ($1, 'customer', $2, $3, $4, $5, 'sent', NOW())`, [customer.id, customer.phone, smsMsg, msgType, smsRes.sid]);
                console.log(`📨 ${msgType} SMS sendt til ${customer.phone}`);
              }
            } catch(e) { console.error('⚠️ Kunde-SMS feilet:', e.message); }
          }
          // Uttrekk-SMS: AI-oppsummering av samtalen til montør/eier
          if (fullTranscript && company.sms_extract_employee !== false) {
            await sendExtractionSms(fullTranscript, customer, company);
          }
          console.log(`✅ Post-completion done for call ${session.call_sid}`);
        } catch (postErr) {
          console.error('🚨 Post-completion error:', postErr.message);
          try {
            await db.run(`UPDATE calls SET error_flag = true, error_details = $1 WHERE twilio_call_sid = $2`, postErr.message, session.call_sid);
            if (session.customer_id) await db.run('UPDATE customers SET error_flag = true, error_details = $1 WHERE id = $2', 'Post-completion: ' + postErr.message, session.customer_id);
            await sendErrorAlert(company, session.call_sid, postErr.message, null);
          } catch(e) {}
        }
      });
      return;
    } else {
      // SPEED: Send TwiML FIRST with state-aware hints, THEN update DB in background
      naturalSay(twiml, result.response);
      gatherCustomerSpeech(twiml, `${BASE_URL}/twilio/voice/respond?sessionId=${sessionId}`, data);
      res.type('text/xml').send(twiml.toString());

      // DB writes in background — don't block the voice response!
      setImmediate(async () => {
        try {
          await db.run(`UPDATE call_sessions SET collected_data = $1, conversation_history = $2, state = 'collecting' WHERE id = $3`,
            JSON.stringify(result.collectedData), JSON.stringify(result.conversationHistory), sessionId);

          if (customerId) {
            const cu = []; const cv = []; let ci = 1;
            if (data.navn) { cu.push(`name = $${ci++}`); cv.push(data.navn); }
            if (data.adresse) { cu.push(`address = $${ci++}`); cv.push(data.adresse); }
            if (data.telefon) { cu.push(`phone = $${ci++}`); cv.push(data.telefon); }
            if (data.dato) { cu.push(`preferred_date = $${ci++}`); cv.push(data.dato); }
            if (data.klokkeslett) { cu.push(`preferred_time = $${ci++}`); cv.push(data.klokkeslett); }
            const pm = (data.adresse || '').match(/\b(\d{4})\b/);
            if (pm) { cu.push(`postal_code = $${ci++}`); cv.push(pm[1]); }
            if (cu.length > 0) { cv.push(customerId); await db.run(`UPDATE customers SET ${cu.join(', ')} WHERE id = $${ci}`, ...cv); }
          }
        } catch(bgErr) {
          console.error('⚠️ Background DB write failed:', bgErr.message);
        }
      });
      return; // Already sent response
    }
  } catch (err) {
    console.error('🚨 CRITICAL ERROR in /twilio/voice/respond:', err.message, err.stack);
    const twiml = new VoiceResponse();
    naturalSay(twiml, 'Beklager, jeg opplevde en teknisk feil. Kan du si det en gang til?');
    gatherCustomerSpeech(twiml, `${BASE_URL}/twilio/voice/respond?sessionId=${sessionId || ''}`);
    res.type('text/xml').send(twiml.toString());
    
    // Save transcript + error alert in background
    if (session) {
      setImmediate(async () => {
        try {
          // KRITISK: Lagre samtalehistorikk SELV ved feil — for feilsøking og oppfølging
          const history = JSON.parse(session.conversation_history || '[]');
          const errorTranscript = history.map(msg => `${msg.role === 'assistant' ? 'AI' : 'Kunde'}: ${msg.content}`).join('\n') || '(Feil oppsto før samtale)';
          await db.run(
            `UPDATE calls SET status = 'completed', call_outcome = 'error', error_flag = true, error_details = $1, transcript = COALESCE(NULLIF(transcript, ''), $2) WHERE twilio_call_sid = $3`,
            err.message, errorTranscript, session.call_sid || ''
          );
          if (session.customer_id) {
            await db.run('UPDATE customers SET error_flag = true, error_details = $1 WHERE id = $2', 'Respond error: ' + err.message, session.customer_id);
          }
          if (company) {
            await sendErrorAlert(company, session.call_sid, err.message, session.customer_id);
          }
        } catch(e) { console.error('⚠️ Error handler cleanup failed:', e.message); }
      });
    }
  }
});

// ===============================================================
// 3. RECORDING WEBHOOK - Save audio URL
// ===============================================================
app.post('/twilio/recording', async (req, res) => {
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;

  console.log(`🎙️ Recording callback received — CallSid: ${callSid}, URL: ${recordingUrl}, Status: ${req.body.RecordingStatus}`);

  // Find and update the call
  const call = await db.get('SELECT * FROM calls WHERE twilio_call_sid = $1', callSid);
  if (call) {
    await db.run('UPDATE calls SET audio_url = $1 WHERE id = $2', recordingUrl, call.id);
    if (call.customer_id) {
      await db.run('UPDATE customers SET audio_url = $1 WHERE id = $2', recordingUrl, call.customer_id);
      console.log(`✅ Audio URL saved to customer ${call.customer_id} and call ${call.id}`);
      // Count all calls for this customer
      const callCountRow = await db.get('SELECT COUNT(*) as count FROM calls WHERE customer_id = $1', call.customer_id);
      await db.run('UPDATE customers SET call_count = $1 WHERE id = $2', callCountRow.count, call.customer_id);
    }
    
    // Auto-transkriber hele opptaket + trekk ut kundeinfo (kjører i bakgrunn)
    transcribeFullRecording(recordingUrl, call.id).then(result => {
      if (result) {
        console.log(`✅ Full transkripsjon + info-uttrekk ferdig for call ${call.id}`);
      }
    }).catch(err => {
      console.error(`⚠️ Bakgrunn-transkripsjon feilet for call ${call.id}:`, err.message);
    });
  }

  res.sendStatus(200);
});

// ===============================================================
// 3b. CALL STATUS CALLBACK — catches hangups, failures, all endings
// ===============================================================
app.post('/twilio/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus; // completed, busy, failed, no-answer, canceled
  const duration = req.body.CallDuration || '0';

  console.log(`📞 Call status: ${callSid} → ${callStatus} (${duration}s)`);

  try {
    const call = await db.get('SELECT * FROM calls WHERE twilio_call_sid = $1', callSid);
    if (call && call.status === 'in-progress') {
      // Call ended but was never completed via normal flow = hangup/abandoned
      const session = await db.get('SELECT * FROM call_sessions WHERE call_sid = $1', callSid);
      const history = session ? JSON.parse(session.conversation_history || '[]') : [];
      const transcript = history.map(msg => `${msg.role === 'assistant' ? 'AI' : 'Kunde'}: ${msg.content}`).join('\n') || '(Ingen samtale registrert)';

      let outcome = 'hangup';
      if (callStatus === 'busy') outcome = 'busy';
      else if (callStatus === 'failed') outcome = 'failed';
      else if (callStatus === 'no-answer') outcome = 'no_answer';
      else if (callStatus === 'canceled') outcome = 'canceled';

      await db.run(
        `UPDATE calls SET status = 'completed', call_outcome = $1, call_duration = $2, transcript = COALESCE(NULLIF(transcript, ''), $3) WHERE id = $4`,
        outcome, parseInt(duration), transcript, call.id
      );
      console.log(`✅ Call ${callSid} finalized as '${outcome}' (${duration}s)`);

      // Auto-analyze hangup calls too (background)
      if (transcript && transcript !== '(Ingen samtale registrert)') {
        setImmediate(async () => {
          try {
            const company = await db.get('SELECT * FROM companies WHERE id = $1', call.company_id);
            const CallAnalyzer = require('./call-analyzer');
            const analyzer = new CallAnalyzer(process.env.OPENAI_API_KEY);
            const analysis = await analyzer.analyzeSingleCall(transcript, company?.name || 'Ukjent');
            if (analysis) {
              await db.run(`UPDATE calls SET analysis_json = $1 WHERE id = $2`, JSON.stringify(analysis), call.id);
              if (pool) {
                await autoImproveFromCall(pool, call.id, call.company_id, transcript, analysis);
              }
            }
          } catch (e) { console.error('⚠️ Hangup auto-analyse feilet:', e.message); }

          // Uttrekk-SMS for hangup — montør/eier mister ikke leads
          try {
            if (company && company.sms_extract_employee !== false && company.montour_phone) {
              const customer = call.customer_id ? await db.get('SELECT * FROM customers WHERE id = $1', call.customer_id) : { name: 'Ukjent innringer', phone: 'Ukjent' };
              await sendExtractionSms(transcript, customer, company);
              console.log(`📨 Uttrekk-SMS sendt for hangup-samtale ${callSid}`);
            }
          } catch(e) { console.error('⚠️ Hangup uttrekk-SMS feilet:', e.message); }
        });
      }
    }
  } catch (err) {
    console.error('⚠️ Call status callback error:', err.message);
  }

  res.sendStatus(200);
});

// ===============================================================

  // ===== API: Get messages for a customer =====
  app.get('/api/customers/:id/messages', async (req, res) => {
    try {
      const msgs = await db.all(
        'SELECT * FROM messages WHERE customer_id = $1 ORDER BY created_at DESC',
        req.params.id
      );
      res.json(msgs);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ===== API: Get messages for a company =====
  app.get('/api/companies/:id/messages', async (req, res) => {
    try {
      const msgs = await db.all(
        `SELECT m.*, c.name as customer_name, c.phone as customer_phone 
         FROM messages m 
         LEFT JOIN customers c ON m.customer_id = c.id 
         WHERE m.company_id = $1 OR c.company_id = $1
         ORDER BY m.created_at DESC LIMIT 100`,
        req.params.id
      );
      res.json(msgs);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

// 4. INCOMING SMS - Handle montør responses and customer photos
// ===============================================================
app.post('/twilio/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';
  const mediaUrl = req.body.MediaUrl0;

  console.log(`💬 SMS from ${from}: ${body}`);

  const twiml = new MessagingResponse();

  // Check if it's a photo from a customer
  if (mediaUrl) {
    const customer = await db.get('SELECT c.*, co.montour_phone FROM customers c JOIN companies co ON c.company_id = co.id WHERE c.phone = $1 ORDER BY c.created_at DESC LIMIT 1', from);
    if (customer) {
      const company = await db.get('SELECT * FROM companies WHERE id = $1', customer.company_id);
      await forwardImageToMontour(customer, company, mediaUrl);
      twiml.message('Takk! Bildet er sendt videre til montøren. 📸');
    }
  } else {
    // Check for BEKREFT command from worker
    const bekreftMatch = body.trim().match(/^BEKREFT\s+(\d+)/i);
    if (bekreftMatch) {
      const customerId = parseInt(bekreftMatch[1]);
      try {
        const customer = await db.get('SELECT * FROM customers WHERE id = $1', customerId);
        if (!customer) {
          twiml.message('⚠️ Fant ingen kunde med ID ' + customerId);
        } else {
          const company = await db.get('SELECT * FROM companies WHERE id = $1', customer.company_id);
          // Verify sender is worker for this company
          if (company && company.montour_phone && from.replace(/\s/g,'').includes(company.montour_phone.replace(/\+/g,''))) {
            // Confirm the appointment
            const label = APPOINTMENT_LABELS[company.industry] || 'time';
            await db.run(`UPDATE customers SET confirmation_status = 'confirmed', confirmed_at = NOW(), confirmed_by = 'SMS', status = CASE WHEN status = 'Ny' THEN 'Booket' ELSE status END WHERE id = $1`, customerId);
            
            // Send confirmation SMS to customer
            if (company.sms_confirm_customer !== false && customer.phone) {
              const dateText = customer.preferred_date ? `\n📅 Dato: ${customer.preferred_date}` : '';
              const timeText = customer.preferred_time ? `\n⏰ Tid: ${customer.preferred_time}` : '';
              const confirmMsg = `Hei${customer.name ? ' ' + customer.name : ''}! Din ${label} hos ${company.name} er bekreftet.${dateText}${timeText}${customer.service_requested ? '\nTjeneste: ' + customer.service_requested : ''}\nVi gleder oss til å se deg! 😊`;
              const { sendSms: smsFunc } = require('./sms-handler');
              await smsFunc(customer.phone, confirmMsg.trim());
            }
            
            // Reminder handled automatically by the 15-min scheduler
            
            twiml.message(`✅ ${label.charAt(0).toUpperCase() + label.slice(1)} for ${customer.name} er bekreftet! Bekreftelse sendt til kunden.`);
          } else {
            twiml.message('⚠️ Du har ikke tilgang til å bekrefte denne bestillingen.');
          }
        }
      } catch(e) {
        console.error('BEKREFT error:', e);
        twiml.message('⚠️ Noe gikk galt ved bekreftelse. Prøv igjen.');
      }
    } else {
      // Handle other montør SMS responses
      const result = await handleIncomingSms(from, body);
      
      if (result && result.handled) {
        if (result.action === 'accepted') {
          twiml.message('✅ Registrert! Oppdraget er godtatt.');
        } else if (result.action === 'price_set') {
          twiml.message(`✅ Pris ${result.price} kr registrert.`);
        } else if (result.action === 'completed') {
          twiml.message('✅ Oppdraget er registrert som fullført!');
        } else if (result.action === 'new_sms_lead' || result.action === 'existing_customer_sms') {
          twiml.message('Takk for meldingen! Den er registrert og vi tar kontakt. 😊');
        } else {
          twiml.message('✅ Kommentaren din er lagret.');
        }
      } else {
        twiml.message('Takk for meldingen! Den er registrert og vi tar kontakt. 😊');
      }
    }
  }

  res.type('text/xml').send(twiml.toString());
});

// ===============================================================
// 5. REST API - For CRM frontend
// ===============================================================

// Get all customers
app.get('/api/customers', async (req, res) => {
  const customers = await db.all(`
    SELECT c.*, co.name as company_name, co.industry as company_industry
    FROM customers c
    LEFT JOIN companies co ON c.company_id = co.id
    ORDER BY c.created_at DESC
  `);
  res.json(customers);
});

// Advanced customer search (MUST be before /api/customers/:id)
app.get('/api/customers/search', async (req, res) => {
  const { q, status, company_id, postal_code, price_min, price_max, date_from, date_to, cancelled } = req.query;
  let sql = `
    SELECT c.*, co.name as company_name, co.industry as company_industry,
           (SELECT COUNT(*) FROM calls cl WHERE cl.customer_id = c.id) as call_count,
           (SELECT COUNT(*) FROM bookings bk WHERE bk.customer_id = c.id) as booking_count
    FROM customers c
    LEFT JOIN companies co ON c.company_id = co.id
    WHERE 1=1
  `;
  const params = [];
  let paramIdx = 1;
  
  if (q) {
    sql += ` AND (c.name LIKE $${paramIdx} OR c.phone LIKE $${paramIdx + 1} OR c.address LIKE $${paramIdx + 2} OR c.comment LIKE $${paramIdx + 3})`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    paramIdx += 4;
  }
  if (status) { sql += ` AND c.status = $${paramIdx++}`; params.push(status); }
  if (company_id) { sql += ` AND c.company_id = $${paramIdx++}`; params.push(company_id); }
  if (postal_code) { sql += ` AND c.postal_code = $${paramIdx++}`; params.push(postal_code); }
  if (price_min) { sql += ` AND c.price >= $${paramIdx++}`; params.push(price_min); }
  if (price_max) { sql += ` AND c.price <= $${paramIdx++}`; params.push(price_max); }
  if (date_from) { sql += ` AND c.preferred_date >= $${paramIdx++}`; params.push(date_from); }
  if (date_to) { sql += ` AND c.preferred_date <= $${paramIdx++}`; params.push(date_to); }
  if (cancelled === '1') { sql += ' AND c.cancelled = 1'; }
  if (cancelled === '0') { sql += ' AND (c.cancelled = 0 OR c.cancelled IS NULL)'; }
  
  sql += ' ORDER BY c.created_at DESC LIMIT 500';
  res.json(await db.all(sql, ...params));
});

// Get single customer
app.get('/api/customers/:id', async (req, res) => {
  const customer = await db.get(`
    SELECT c.*, co.name as company_name, co.industry as company_industry
    FROM customers c
    LEFT JOIN companies co ON c.company_id = co.id
    WHERE c.id = $1
  `, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  res.json(customer);
});

// Update customer
app.patch('/api/customers/:id', async (req, res) => {
  const fields = req.body;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = Object.values(fields);
  const idIdx = keys.length + 1;
  await db.run(`UPDATE customers SET ${sets}, updated_at = NOW() WHERE id = $${idIdx}`, ...vals, req.params.id);
  res.json({ success: true });
});

// Create customer
app.post('/api/customers', async (req, res) => {
  const { company_id, name, phone, address, email, preferred_date, service_requested, comment, postal_code, preferred_time, preferred_date_end, availability_type, availability_json, excluded_dates, status, source, duration_minutes, max_concurrent, break_minutes } = req.body;
  const result = await db.run(`INSERT INTO customers (company_id, name, phone, address, email, preferred_date, service_requested, comment, postal_code, preferred_time, preferred_date_end, availability_type, availability_json, excluded_dates, status, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    company_id, name, phone, address, email, preferred_date, service_requested, comment, postal_code, preferred_time, preferred_date_end, availability_type, availability_json || null, excluded_dates || null, status || 'Ny', source || 'Manuell');
  
  const customerId = result.rows[0].id;

  // Create booking record for calendar visibility
  if (preferred_date) {
    try {
      const dur = parseInt(duration_minutes) || 60;
      // Calculate end_time if preferred_time given
      let endTime = null;
      if (preferred_time) {
        const startStr = preferred_time.split(' - ')[0].trim();
        const [h, m] = startStr.split(':').map(Number);
        if (!isNaN(h)) {
          const endMin = h * 60 + (m || 0) + dur;
          endTime = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;
        }
      }
      await db.run(
        `INSERT INTO bookings (customer_id, company_id, service_requested, preferred_date, preferred_time, comment, source, status, confirmation_status, duration_minutes, end_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10)`,
        customerId, company_id, service_requested, preferred_date, preferred_time, comment, source || 'Manuell', status || 'Ny', dur, endTime
      );
    } catch(bErr) { console.error('[BOOKING CREATE] Error:', bErr.message); }
  }

  // SMS cascade — depends on whether company requires worker approval
  try {
    const customer = await db.get('SELECT * FROM customers WHERE id = $1', customerId);
    const company = await db.get('SELECT * FROM companies WHERE id = $1', company_id);
    if (customer && company && customer.phone) {
      if (company.requires_worker_approval) {
        // APPROVAL FLOW: Send to worker for confirmation first, customer gets "venter på bekreftelse"
        const label = APPOINTMENT_LABELS[company.industry] || 'time';
        const dateText = customer.preferred_date ? `📅 ${customer.preferred_date}` : '';
        const timeText = customer.preferred_time ? `⏰ ${customer.preferred_time}` : '';
        
        // SMS to worker: approve request
        if (company.sms_notify_worker !== false && company.montour_phone) {
          const workerMsg = `📞 Ny kunde venter!\nKunde: ${customer.name}\nTlf: ${customer.phone}\n${dateText}\n${timeText}\nTjeneste: ${customer.service_requested || '–'}\n\nSvar BEKREFT ${customerId} for å godkjenne.`;
          const { sendSms } = require('./sms-handler');
          await sendSms(company.montour_phone, workerMsg.trim());
        }
        
        // SMS to customer: waiting for confirmation
        if (company.sms_confirm_customer !== false) {
          const { sendSms } = require('./sms-handler');
          const custMsg = `Hei${customer.name ? ' ' + customer.name : ''}! Din forespørsel om ${label} hos ${company.name} er mottatt.\n${dateText}\nVi bekrefter tid og dato så snart som mulig. Ha en fin dag! 😊`;
          await sendSms(customer.phone, custMsg.trim());
        }
        
        // Set status to pending
        await db.run(`UPDATE customers SET confirmation_status = 'pending' WHERE id = $1`, customerId);
        console.log(`[APPROVAL FLOW] Worker approval SMS sent for customer ${customerId}`);
      } else {
        // DIRECT FLOW: Send confirmation + notify worker immediately
        await sendBookingConfirmation(customer, company);
        await sendToMontour(customer, company);
        await db.run(`UPDATE customers SET confirmation_status = 'confirmed' WHERE id = $1`, customerId);
        console.log(`[SMS CASCADE] Triggered for manually created customer ${customerId}`);
      }
    }
  } catch (smsErr) {
    console.error('[SMS CASCADE] Error:', smsErr.message);
    // Don't fail customer creation if SMS fails
  }

  res.json({ id: customerId });
});

// Full customer update (same as PATCH but explicit)
app.put('/api/customers/:id', async (req, res) => {
  const fields = req.body;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = Object.values(fields);
  const idIdx = keys.length + 1;
  await db.run(`UPDATE customers SET ${sets}, updated_at = NOW() WHERE id = $${idIdx}`, ...vals, req.params.id);
  const customer = await db.get('SELECT * FROM customers WHERE id = $1', req.params.id);
  res.json(customer);
});

// Delete customer
app.delete('/api/customers/:id', async (req, res) => {
  await db.run('DELETE FROM calls WHERE customer_id = $1', req.params.id);
  await db.run('DELETE FROM customers WHERE id = $1', req.params.id);
  res.json({ success: true });
});

// ===== WORKER APPROVAL / CONFIRMATION =====

// Industry-specific appointment labels
const APPOINTMENT_LABELS = {
  planke: 'befaring', vaskeri: 'rengjøringstime', kosmetikk: 'behandling',
  vvs: 'rørleggertime', elektriker: 'elektrikertime', maler: 'malertime',
  antikviteter: 'vurdering', frisor: 'frisørtime', general: 'time'
};

// Get pending confirmations for a company
app.get('/api/companies/:id/pending', async (req, res) => {
  try {
    const customers = await db.all(
      `SELECT * FROM customers WHERE company_id = $1 AND confirmation_status = 'pending' AND status NOT IN ('Avbestilt','Fullført','Betalt') ORDER BY preferred_date ASC NULLS LAST, created_at ASC`,
      req.params.id
    );
    res.json(customers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get upcoming appointments (confirmed) for a company
app.get('/api/companies/:id/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const customers = await db.all(
      `SELECT * FROM customers WHERE company_id = $1 AND status IN ('Booket','Inngått avtale') AND (preferred_date >= $2 OR preferred_date IS NULL) ORDER BY preferred_date ASC NULLS LAST`,
      [req.params.id, today]
    );
    res.json(customers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Confirm a customer appointment (worker approves)
app.post('/api/customers/:id/confirm', async (req, res) => {
  try {
    const customer = await db.get('SELECT * FROM customers WHERE id = $1', req.params.id);
    if (!customer) return res.status(404).json({ error: 'Kunde ikke funnet' });
    
    const company = await db.get('SELECT * FROM companies WHERE id = $1', customer.company_id);
    const confirmedBy = req.body.confirmed_by || 'CRM';
    const confirmedDate = req.body.confirmed_date || null;
    const confirmedTime = req.body.confirmed_time || null;
    
    // Build dynamic update
    const updates = { confirmation_status: 'confirmed', confirmed_by: confirmedBy };
    if (confirmedDate) updates.preferred_date = confirmedDate;
    if (confirmedTime) updates.preferred_time = confirmedTime;
    if (customer.status === 'Ny') updates.status = 'Booket';
    
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.run(`UPDATE customers SET ${setClauses}, confirmed_at = NOW() WHERE id = $1`, req.params.id, ...Object.values(updates));
    
    // Return success IMMEDIATELY — SMS sendes i bakgrunnen
    res.json({ success: true, message: 'Bestilling bekreftet!' });
    
    // SMS til kunde (bakgrunn — feiler ikke bekreftelsen)
    if (company && company.sms_confirm_customer !== false && customer.phone) {
      try {
        const { sendSms } = require('./sms-handler');
        const label = APPOINTMENT_LABELS[company.industry] || 'time';
        const dateText = confirmedDate || customer.preferred_date || '';
        const timeText = confirmedTime || customer.preferred_time || '';
        const body = `Hei${customer.name ? ' ' + customer.name : ''}! Din ${label} hos ${company.name} er bekreftet.${dateText ? '\n📅 Dato: ' + dateText : ''}${timeText ? '\n⏰ Tid: ' + timeText : ''}${customer.service_requested ? '\nTjeneste: ' + customer.service_requested : ''}\nVi gleder oss til å se deg! 😊`;
        await sendSms(customer.phone, body.trim());
        console.log('✅ Bekreftelse-SMS sendt til kunde:', customer.phone);
      } catch(e) { console.error('⚠️ Kunde SMS feilet (bekreftelsen er likevel lagret):', e.message); }
    }
    
    // SMS til montør (bakgrunn)
    if (company && company.sms_notify_worker !== false && company.montour_phone) {
      try {
        const { sendSms } = require('./sms-handler');
        const label = APPOINTMENT_LABELS[company.industry] || 'time';
        const dateText = confirmedDate || customer.preferred_date || 'Ikke satt';
        const timeText = confirmedTime || customer.preferred_time || 'Hele dagen';
        const montourMsg = `📞 Ny kunde venter! — ${company.name}\nKunde: ${customer.name || 'Ukjent'}\nTlf: ${customer.phone || '–'}\nAdresse: ${customer.address || '–'}\nTjeneste: ${customer.service_requested || '–'}\n📅 Dato: ${dateText}\n⏰ Tid: ${timeText}${customer.comment ? '\nKommentar: ' + customer.comment : ''}`;
        await sendSms(company.montour_phone, montourMsg.trim());
        console.log('✅ Montør-SMS sendt til:', company.montour_phone);
      } catch(e) { console.error('⚠️ Montør SMS feilet (bekreftelsen er likevel lagret):', e.message); }
    }
  } catch(e) { 
    console.error('❌ Confirm endpoint error:', e.message, e.stack);
    res.status(500).json({ error: e.message }); 
  }
});

// ===== CONFIRM BOOKING (per booking, not per customer) =====
app.post('/api/bookings/:id/confirm', async (req, res) => {
  try {
    const booking = await db.get('SELECT * FROM bookings WHERE id = $1', req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
    
    const customer = await db.get('SELECT * FROM customers WHERE id = $1', booking.customer_id);
    const company = await db.get('SELECT * FROM companies WHERE id = $1', booking.company_id);
    const confirmedBy = req.body.confirmed_by || 'CRM';
    const confirmedDate = req.body.confirmed_date || booking.preferred_date || null;
    const confirmedTime = req.body.confirmed_time || booking.preferred_time || null;
    
    await db.run(
      `UPDATE bookings SET confirmation_status = 'confirmed', confirmed_at = NOW(), confirmed_by = $1, 
       preferred_date = COALESCE($2::text, preferred_date), preferred_time = COALESCE($3::text, preferred_time),
       status = CASE WHEN status IN ('Ny','Henvendelse') THEN 'Booket' ELSE status END
       WHERE id = $4`,
      confirmedBy, confirmedDate, confirmedTime, req.params.id
    );
    
    if (customer) {
      await db.run(`UPDATE customers SET confirmation_status = 'confirmed', confirmed_at = NOW(), confirmed_by = $1,
        status = CASE WHEN status = 'Ny' THEN 'Booket' ELSE status END WHERE id = $2`, confirmedBy, customer.id);
    }
    
    res.json({ success: true, message: 'Booking bekreftet!' });
    
    // SMS til kunde (bakgrunn)
    if (company && company.sms_confirm_customer !== false && customer?.phone) {
      try {
        const { sendSms } = require('./sms-handler');
        const dateText = confirmedDate || '';
        const timeText = confirmedTime || '';
        const body = `Hei${customer.name ? ' ' + customer.name : ''}! Din bestilling hos ${company.name} er bekreftet.${dateText ? '\n📅 Dato: ' + dateText : ''}${timeText ? '\n⏰ Tid: ' + timeText : ''}${booking.service_requested ? '\nTjeneste: ' + booking.service_requested : ''}\nVi gleder oss til å se deg! 😊`;
        const smsResult = await sendSms(customer.phone, body.trim());
        if (smsResult) {
          await db.run(`INSERT INTO messages (customer_id, recipient_type, recipient_phone, message_body, message_type, twilio_sid, status, created_at) VALUES ($1, 'customer', $2, $3, 'booking_confirmation', $4, 'sent', NOW())`,
            customer.id, customer.phone, body.trim(), smsResult.sid);
        }
        console.log('✅ Bekreftelse-SMS sendt til kunde:', customer.phone);
      } catch(e) { console.error('⚠️ Kunde SMS feilet:', e.message); }
    }
  } catch(e) {
    console.error('❌ Booking confirm error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== BOOKING: ASSIGN EMPLOYEE =====
// Calendar uses customers table, so update assigned_to there
app.patch('/api/bookings/:id/assign', async (req, res) => {
  try {
    const { assigned_to } = req.body;
    await db.run('UPDATE customers SET assigned_to = $1 WHERE id = $2', assigned_to || null, req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== COMPANY: MAX CONCURRENT BOOKINGS =====
app.patch('/api/companies/:id/max-concurrent', async (req, res) => {
  try {
    const { max_concurrent_bookings } = req.body;
    const val = Math.max(1, Math.min(20, parseInt(max_concurrent_bookings) || 5));
    await pool.query('UPDATE companies SET max_concurrent_bookings = $1 WHERE id = $2', [val, req.params.id]);
    res.json({ success: true, max_concurrent_bookings: val });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== AVAILABILITY MANAGEMENT =====

// Get customer availability
app.get('/api/customers/:id/availability', async (req, res) => {
  const customer = await db.get('SELECT availability_json, excluded_dates, preferred_date, preferred_date_end, preferred_time FROM customers WHERE id = $1', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Kunde ikke funnet' });
  
  let slots = [];
  try { slots = JSON.parse(customer.availability_json || '[]'); } catch(e) {}
  let excluded = [];
  try { excluded = JSON.parse(customer.excluded_dates || '[]'); } catch(e) {}
  
  res.json({ slots, excluded, preferred_date: customer.preferred_date, preferred_date_end: customer.preferred_date_end, preferred_time: customer.preferred_time });
});

// Set customer availability (structured)
app.put('/api/customers/:id/availability', async (req, res) => {
  const { slots } = req.body;
  await db.run('UPDATE customers SET availability_json = $1, updated_at = NOW() WHERE id = $2',
    JSON.stringify(slots || []), req.params.id);
  res.json({ success: true });
});

// Exclude a date from customer availability
app.post('/api/customers/:id/exclude-date', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Dato mangler' });
  
  const customer = await db.get('SELECT excluded_dates FROM customers WHERE id = $1', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Kunde ikke funnet' });
  
  let excluded = [];
  try { excluded = JSON.parse(customer.excluded_dates || '[]'); } catch(e) {}
  
  if (!excluded.includes(date)) {
    excluded.push(date);
    await db.run('UPDATE customers SET excluded_dates = $1, updated_at = NOW() WHERE id = $2',
      JSON.stringify(excluded), req.params.id);
  }
  res.json({ success: true, excluded });
});

// Remove excluded date (re-include)
app.delete('/api/customers/:id/exclude-date', async (req, res) => {
  const { date } = req.body;
  const customer = await db.get('SELECT excluded_dates FROM customers WHERE id = $1', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Kunde ikke funnet' });
  
  let excluded = [];
  try { excluded = JSON.parse(customer.excluded_dates || '[]'); } catch(e) {}
  
  excluded = excluded.filter(d => d !== date);
  await db.run('UPDATE customers SET excluded_dates = $1, updated_at = NOW() WHERE id = $2',
    JSON.stringify(excluded), req.params.id);
  res.json({ success: true, excluded });
});

// ===== COMPANY AVAILABILITY / TIDSLUKE MANAGEMENT =====

// Get availability for a company
app.get('/api/company/:id/availability', async (req, res) => {
  try {
    const slots = await db.all(
      `SELECT * FROM availability WHERE company_id = $1 ORDER BY day_of_week, start_time`,
      req.params.id
    );
    res.json(slots);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set availability for a company (bulk replace)
app.post('/api/company/:id/availability', async (req, res) => {
  try {
    const { slots } = req.body; // array of { day_of_week, start_time, end_time, slot_duration }
    const companyId = req.params.id;
    
    // Delete existing and insert new
    await db.run('DELETE FROM availability WHERE company_id = $1', companyId);
    
    for (const slot of slots) {
      await db.run(
        `INSERT INTO availability (company_id, day_of_week, start_time, end_time, slot_duration) 
         VALUES ($1, $2, $3, $4, $5)`,
        companyId, slot.day_of_week, slot.start_time, slot.end_time, slot.slot_duration || 60
      );
    }
    
    res.json({ success: true, count: slots.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Toggle a single availability slot active/inactive
app.put('/api/availability/:id/toggle', async (req, res) => {
  try {
    await db.run('UPDATE availability SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1', req.params.id);
    const slot = await db.get('SELECT * FROM availability WHERE id = $1', req.params.id);
    res.json(slot);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete a single availability slot
app.delete('/api/availability/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM availability WHERE id = $1', req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Avbestill en bestilling
app.post('/api/customers/:id/cancel', async (req, res) => {
  await db.run(`UPDATE customers SET cancelled = 1, cancelled_at = NOW(), status = 'Avbestilt', updated_at = NOW() WHERE id = $1`,
    req.params.id);
  res.json({ success: true, message: 'Bestilling avbestilt' });
});

// Undo cancellation
app.post('/api/customers/:id/uncancel', async (req, res) => {
  await db.run(`UPDATE customers SET cancelled = 0, cancelled_at = NULL, status = 'Booket', updated_at = NOW() WHERE id = $1`,
    req.params.id);
  res.json({ success: true, message: 'Avbestilling angra' });
});

// Get all calls for a customer (with audio URLs)
app.get('/api/customers/:id/calls', async (req, res) => {
  const calls = await db.all(`
    SELECT c.*, b.service_requested as booking_service, b.preferred_date as booking_date, 
           b.preferred_time as booking_time, b.status as booking_status, b.confirmation_status as booking_confirmation,
           b.preferred_employee as booking_employee, b.comment as booking_comment, b.id as booking_id
    FROM calls c
    LEFT JOIN bookings b ON b.call_id = c.id
    WHERE c.customer_id = $1 ORDER BY c.created_at DESC
  `, req.params.id);
  res.json(calls);
});

// Get bookings for a customer
app.get('/api/customers/:id/bookings', async (req, res) => {
  const bookings = await db.all(`
    SELECT b.*, c.transcript, c.audio_url, c.duration_seconds, c.created_at as call_date, c.extracted_info
    FROM bookings b
    LEFT JOIN calls c ON b.call_id = c.id
    WHERE b.customer_id = $1 ORDER BY b.created_at DESC
  `, req.params.id);
  res.json(bookings);
});

// Get all calls for a phone number (across companies)
app.get('/api/calls/by-phone/:phone', async (req, res) => {
  const calls = await db.all(`
    SELECT c.*, cu.name as customer_name, co.name as company_name
    FROM calls c
    LEFT JOIN customers cu ON c.customer_id = cu.id
    LEFT JOIN companies co ON c.company_id = co.id
    WHERE cu.phone = $1
    ORDER BY c.created_at DESC
  `, req.params.phone);
  res.json(calls);
});

// ===============================================================
// SAMTALE-ANALYSE API
// ===============================================================

// Hent alle samtaler med analyser
app.get('/api/calls', async (req, res) => {
  const companyId = req.query.company_id;
  let calls;
  if (companyId) {
    calls = await db.all(`
      SELECT c.*, cu.name as customer_name, co.name as company_name
      FROM calls c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN companies co ON c.company_id = co.id
      WHERE c.company_id = $1
      ORDER BY c.created_at DESC
    `, companyId);
  } else {
    calls = await db.all(`
      SELECT c.*, cu.name as customer_name, co.name as company_name
      FROM calls c
      LEFT JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN companies co ON c.company_id = co.id
      ORDER BY c.created_at DESC
    `);
  }
  res.json(calls);
});

// Hent analyse for en spesifikk samtale
app.get('/api/calls/:id/analysis', async (req, res) => {
  const call = await db.get('SELECT * FROM calls WHERE id = $1', req.params.id);
  if (!call) return res.status(404).json({ error: 'Samtale ikke funnet' });
  
  try {
    const analysis = JSON.parse(call.analysis_json || '{}');
    res.json({ 
      callId: call.id, 
      transcript: call.transcript,
      audioUrl: call.audio_url,
      analysis,
      callOutcome: call.call_outcome,
      createdAt: call.created_at
    });
  } catch (e) {
    res.json({ callId: call.id, transcript: call.transcript, analysis: {} });
  }
});

// Kjør forbedringsrapport for alle nylige samtaler
app.post('/api/calls/improvement-report', async (req, res) => {
  try {
    const CallAnalyzer = require('./call-analyzer');
    const analyzer = new CallAnalyzer(process.env.OPENAI_API_KEY);
    
    // Hent siste 20 samtaler med analyser
    const calls = await db.all(`
      SELECT * FROM calls 
      WHERE analysis_json IS NOT NULL AND analysis_json != '{}' 
      ORDER BY created_at DESC LIMIT 20
    `);
    
    if (calls.length === 0) {
      return res.json({ message: 'Ingen analyserte samtaler funnet ennå' });
    }
    
    const analyses = calls.map(c => ({
      callId: c.id,
      companyName: c.company_name || 'Ukjent',
      timestamp: c.created_at,
      analysis: JSON.parse(c.analysis_json || '{}')
    }));
    
    const report = await analyzer.generateImprovementReport(analyses);
    res.json(report);
  } catch (err) {
    console.error('Forbedringsrapport feilet:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Re-analyser en samtale manuelt
app.post('/api/calls/:id/reanalyze', async (req, res) => {
  try {
    const call = await db.get(`
      SELECT c.*, co.name as company_name 
      FROM calls c LEFT JOIN companies co ON c.company_id = co.id 
      WHERE c.id = $1
    `, req.params.id);
    if (!call) return res.status(404).json({ error: 'Samtale ikke funnet' });
    
    let transcript = call.transcript;
    
    // Hvis ingen transkripsjon men vi har lyd — transkriber med Whisper
    if (!transcript && call.audio_url) {
      const CallAnalyzer = require('./call-analyzer');
      const analyzer = new CallAnalyzer(process.env.OPENAI_API_KEY);
      const result = await analyzer.transcribeRecording(call.audio_url);
      if (result) {
        transcript = result.text;
        await db.run('UPDATE calls SET transcript = $1 WHERE id = $2', transcript, call.id);
      }
    }
    
    if (!transcript) return res.status(400).json({ error: 'Ingen transkripsjon eller lydopptak tilgjengelig' });
    
    const CallAnalyzer = require('./call-analyzer');
    const analyzer = new CallAnalyzer(process.env.OPENAI_API_KEY);
    const analysis = await analyzer.analyzeSingleCall(transcript, call.company_name || 'Ukjent');
    
    if (analysis) {
      await db.run('UPDATE calls SET analysis_json = $1 WHERE id = $2', JSON.stringify(analysis), call.id);
      res.json({ callId: call.id, analysis });
    } else {
      res.status(500).json({ error: 'Analyse feilet' });
    }
  } catch (err) {
    console.error('Re-analyse feilet:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === AUTO-LEARNING ENDPOINTS ===
app.get('/api/improvements/:companyId', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    const result = await pool.query(
      'SELECT * FROM coe_prompt_improvements WHERE company_id = $1 ORDER BY created_at DESC',
      [req.params.companyId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/improvements/call/:callId', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    const improvements = await getImprovementsForCall(pool, parseInt(req.params.callId));
    res.json(improvements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/improvements/:id/deactivate', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    await deactivateImprovement(pool, parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/improvements/:companyId/active', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    const improvements = await getActiveImprovements(pool, parseInt(req.params.companyId));
    res.json(improvements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All auto-improvements across companies (for CRM Auto-rettinger page)
app.get('/api/auto-improvements', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    const result = await pool.query(
      `SELECT pi.*, c.name as company_name FROM coe_prompt_improvements pi
       LEFT JOIN companies c ON pi.company_id = c.id
       ORDER BY pi.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/auto-improvements/:id', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    const { active } = req.body;
    await pool.query('UPDATE coe_prompt_improvements SET active = $1 WHERE id = $2', [active, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kjør auto-analyse på alle uanalyserte samtaler (manuell trigger fra CRM)
app.post('/api/auto-improvements/run-analysis', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });

    // Finn samtaler som er fullført, har transcript, men IKKE er analysert ennå
    const callsRes = await pool.query(`
      SELECT c.id, c.company_id, c.transcript, c.call_outcome
      FROM calls c
      WHERE c.status = 'completed'
        AND c.transcript IS NOT NULL
        AND LENGTH(c.transcript) > 50
        AND c.id NOT IN (
          SELECT DISTINCT call_id FROM coe_prompt_improvements WHERE call_id IS NOT NULL
        )
      ORDER BY c.created_at DESC
      LIMIT 20
    `);

    const calls = callsRes.rows;
    if (calls.length === 0) {
      return res.json({ message: 'Ingen uanalyserte samtaler funnet', analyzed: 0 });
    }

    res.json({ message: `Starter analyse av ${calls.length} samtaler — kjører i bakgrunnen`, analyzing: calls.length });

    // Kjør i bakgrunnen (ikke blokker respons)
    (async () => {
      let count = 0;
      for (const call of calls) {
        try {
          const analysis = await analyzer.analyzeSingleCall(call.transcript, 'Ukjent');
          await autoImproveFromCall(pool, call.id, call.company_id, call.transcript, analysis);
          count++;
          console.log(`[AUTO-LEARN] Manuell analyse: ${count}/${calls.length} (samtale ${call.id})`);
        } catch (err) {
          console.error(`[AUTO-LEARN] Feil på samtale ${call.id}:`, err.message);
        }
        // Vent 1s mellom kall for å spare OpenAI-kvote
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[AUTO-LEARN] Manuell analyse ferdig: ${count} av ${calls.length} analysert`);
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== TRANSKRIPSJON + INFO-UTTREKK ENDEPUNKTER =====

// Manuell transkripsjon av en samtale
app.post('/api/calls/:id/transcribe', async (req, res) => {
  try {
    const call = await db.get('SELECT * FROM calls WHERE id = $1', req.params.id);
    if (!call) return res.status(404).json({ error: 'Samtale ikke funnet' });
    if (!call.audio_url) return res.status(400).json({ error: 'Ingen lydopptak tilgjengelig for denne samtalen' });
    
    const result = await transcribeFullRecording(call.audio_url, call.id);
    if (result) {
      res.json({ 
        callId: call.id, 
        transcript: result.transcript, 
        extractedInfo: result.extractedInfo,
        message: 'Transkripsjon og info-uttrekk fullført' 
      });
    } else {
      res.status(500).json({ error: 'Transkripsjon feilet' });
    }
  } catch (err) {
    console.error('Transkripsjon-endpoint feilet:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hent transkripsjon + uttrekket info for en samtale
app.get('/api/calls/:id/transcript', async (req, res) => {
  try {
    const call = await db.get('SELECT id, transcript, full_audio_transcript, extracted_info, audio_url FROM calls WHERE id = $1', req.params.id);
    if (!call) return res.status(404).json({ error: 'Samtale ikke funnet' });
    
    let extractedInfo = {};
    try { extractedInfo = JSON.parse(call.extracted_info || '{}'); } catch(e) {}
    
    res.json({
      callId: call.id,
      conversationTranscript: call.transcript,
      fullAudioTranscript: call.full_audio_transcript,
      extractedInfo,
      hasAudio: !!call.audio_url
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transkriber alle samtaler som har lyd men mangler transkripsjon
app.post('/api/calls/transcribe-all', async (req, res) => {
  try {
    const calls = await db.all(`
      SELECT id, audio_url FROM calls 
      WHERE audio_url IS NOT NULL 
      AND (full_audio_transcript IS NULL OR full_audio_transcript = '')
      ORDER BY id DESC
      LIMIT 20
    `);
    
    if (!calls.length) return res.json({ message: 'Ingen samtaler trenger transkripsjon', count: 0 });
    
    // Start transcription in background
    let count = 0;
    for (const call of calls) {
      transcribeFullRecording(call.audio_url, call.id).then(() => count++).catch(() => {});
    }
    
    res.json({ message: `Transkriberer ${calls.length} samtaler i bakgrunnen`, count: calls.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hent bestillinger for kalendervisning
app.get('/api/bookings', async (req, res) => {
  const { start, end, company_id } = req.query;
  let sql = `
    SELECT c.*, co.name as company_name, co.industry as company_industry
    FROM customers c
    LEFT JOIN companies co ON c.company_id = co.id
    WHERE c.preferred_date IS NOT NULL
  `;
  const params = [];
  let paramIdx = 1;
  if (start) { sql += ` AND c.preferred_date >= $${paramIdx++}`; params.push(start); }
  if (end) { sql += ` AND c.preferred_date <= $${paramIdx++}`; params.push(end); }
  if (company_id) { sql += ` AND c.company_id = $${paramIdx++}`; params.push(company_id); }
  sql += ' ORDER BY c.preferred_date ASC, c.preferred_time ASC';
  
  res.json(await db.all(sql, ...params));
});

// iCal-eksport for en enkelt bestilling
app.get('/api/bookings/:id/ical', async (req, res) => {
  try {
    const b = await db.get(`SELECT c.*, co.name as company_name FROM customers c LEFT JOIN companies co ON c.company_id = co.id WHERE c.id = $1`, req.params.id);
    if (!b) return res.status(404).send('Ikke funnet');
    const dateStr = (b.preferred_date || b.appointment_date || new Date().toISOString()).split('T')[0].replace(/-/g, '');
    let startTime = '090000', endTime = '100000';
    const t = b.preferred_time || b.appointment_time || '';
    if (t) { const m = t.match(/(\d{1,2})[:\.]?(\d{2})?/); if (m) { startTime = m[1].padStart(2,'0') + (m[2]||'00') + '00'; const eh = parseInt(m[1])+1; endTime = String(eh).padStart(2,'0') + (m[2]||'00') + '00'; } }
    const svc = b.service_requested || 'Bestilling';
    const ical = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//COE AI Voice Agent//NO',
      'BEGIN:VEVENT',
      `DTSTART:${dateStr}T${startTime}`,`DTEND:${dateStr}T${endTime}`,
      `SUMMARY:${svc} - ${b.name||'Kunde'}`,
      `DESCRIPTION:Kunde: ${b.name||''}\\nTlf: ${b.phone||''}\\nTjeneste: ${svc}\\nSelskap: ${b.company_name||''}`,
      b.address ? `LOCATION:${b.address}` : '',
      `UID:coe-booking-${b.id}@coesystem`,
      'END:VEVENT','END:VCALENDAR'
    ].filter(Boolean).join('\r\n');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bestilling-${b.id}.ics"`);
    res.send(ical);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// iCal-feed for alle bekreftede bestillinger (for Google Calendar subscription)
app.get('/api/calendar/feed', async (req, res) => {
  try {
    const { company_id } = req.query;
    let sql = `SELECT c.*, co.name as company_name FROM customers c LEFT JOIN companies co ON c.company_id = co.id WHERE c.preferred_date IS NOT NULL AND c.status NOT IN ('Avbestilt')`;
    const params = [];
    if (company_id) { sql += ` AND c.company_id = $1`; params.push(company_id); }
    sql += ' ORDER BY c.preferred_date ASC';
    const bookings = await db.all(sql, ...params);
    let events = '';
    bookings.forEach(b => {
      const dateStr = (b.preferred_date||'').split('T')[0].replace(/-/g, '');
      if (!dateStr) return;
      let startTime = '090000', endTime = '100000';
      const t = b.preferred_time || b.appointment_time || '';
      if (t) { const m = t.match(/(\d{1,2})[:\.]?(\d{2})?/); if (m) { startTime = m[1].padStart(2,'0') + (m[2]||'00') + '00'; const eh = parseInt(m[1])+1; endTime = String(eh).padStart(2,'0') + (m[2]||'00') + '00'; } }
      const svc = b.service_requested || 'Bestilling';
      const status = b.confirmation_status === 'confirmed' ? 'BEKREFTET' : 'VENTER';
      events += `BEGIN:VEVENT\r\nDTSTART:${dateStr}T${startTime}\r\nDTEND:${dateStr}T${endTime}\r\nSUMMARY:[${status}] ${svc} - ${b.name||'Kunde'}\r\nDESCRIPTION:Kunde: ${b.name||''}\\nTlf: ${b.phone||''}\\nTjeneste: ${svc}\\nSelskap: ${b.company_name||''}\\nStatus: ${status}\r\n${b.address?'LOCATION:'+b.address+'\r\n':''}UID:coe-booking-${b.id}@coesystem\r\nEND:VEVENT\r\n`;
    });
    const ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//COE AI Voice Agent//NO\r\nX-WR-CALNAME:COE Bestillinger\r\n${events}END:VCALENDAR`;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(ical);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all companies
// ===== CALENDAR EVENTS — confirmed bookings for CRM calendar =====
app.get('/api/companies/:id/calendar-events', async (req, res) => {
  try {
    const events = await db.query(
      `SELECT b.id, b.preferred_date, b.preferred_time, b.service_requested, b.confirmation_status, b.confirmed_at,
              c.name as customer_name, c.phone as customer_phone, c.address as customer_address
       FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
       WHERE b.company_id = $1 AND b.preferred_date IS NOT NULL
       ORDER BY b.preferred_date ASC, b.preferred_time ASC`,
      [req.params.id]
    );
    res.json(events.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/companies', async (req, res) => {
  const companies = await db.all('SELECT * FROM companies ORDER BY name');
  res.json(companies);
});

// Get company with stats
app.get('/api/companies/:id', async (req, res) => {
  const company = await db.get('SELECT * FROM companies WHERE id = $1', req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  const stats = await db.get(`
    SELECT 
      COUNT(*) as total_customers,
      SUM(CASE WHEN status = 'Booket' THEN 1 ELSE 0 END) as booked,
      SUM(CASE WHEN status = 'Fullført' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN cancelled = 1 THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN price IS NOT NULL THEN price ELSE 0 END) as total_revenue
    FROM customers WHERE company_id = $1
  `, req.params.id);
  res.json({ ...company, stats });
});

// Create company
app.post('/api/companies', async (req, res) => {
  try {
    const { name, industry, phone, greeting, montour_phone, login_password, boss_phone, boss_email, sms_notify_worker, sms_confirm_customer, sms_remind_customer, sms_extract_employee, logo_url, requires_worker_approval, address } = req.body;
    
    if (!name || !name.trim()) return res.status(400).json({ error: 'Selskapsnavn er påkrevd' });
    
    // Auto-generate coadmin ID: count existing companies + 1
    const countRow = await db.get('SELECT COUNT(*) as count FROM companies');
    const coadminId = `coadmin${countRow.count + 1}`;
    
    // Auto-generate password if not provided
    const autoPassword = login_password || generatePassword();
    
    // Auto-generate greeting if not provided
    const autoGreeting = greeting || `God dag, du snakker nå med ${name} sin K.I.-assistent. Det vil bli gjort opptak av samtalen for utviklingsformål. Hva kan jeg hjelpe deg med i dag?`;

    // Auto-generate industry questions from auto-company-generator
    const autoCompany = require('./auto-company-generator');
    const safeIndustry = industry && industry.trim() ? industry.trim() : 'generell';
    const generated = autoCompany.generateCompanyConfig(name, safeIndustry);
    
    const result = await db.run(
      `INSERT INTO companies (name, industry, phone, greeting, montour_phone, login_password, boss_phone, boss_email, sms_notify_worker, sms_confirm_customer, sms_remind_customer, sms_extract_employee, industry_questions, follow_up_triggers, standard_routines, sms_template, logo_url, requires_worker_approval, feature_auto_messages, feature_info_in, feature_info_out, feature_phone, feature_chatbot, feature_auto_confirm, feature_employee_alert, feature_customer_confirm, feature_reminder, max_concurrent, break_minutes, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30) RETURNING id`,
      name.trim(), safeIndustry, phone || null, autoGreeting, montour_phone || null, autoPassword, boss_phone || null, boss_email || null,
      sms_notify_worker !== false, sms_confirm_customer !== false, sms_remind_customer !== false, sms_extract_employee !== false,
      JSON.stringify(generated.industryQuestions || []),
      JSON.stringify(generated.followUpTriggers || {}),
      JSON.stringify(generated.standardRoutines || []),
      generated.smsTemplate || null,
      logo_url || null,
      requires_worker_approval === true,
      req.body.feature_auto_messages !== false,
      req.body.feature_info_in !== false,
      req.body.feature_info_out !== false,
      req.body.feature_phone !== false,
      req.body.feature_chatbot !== false,
      req.body.feature_auto_confirm !== false,
      req.body.feature_employee_alert !== false,
      req.body.feature_customer_confirm !== false,
      req.body.feature_reminder !== false,
      Math.max(1, Math.min(10, parseInt(req.body.max_concurrent) || 1)),
      Math.max(0, Math.min(60, parseInt(req.body.break_minutes) || 0)),
      address || null
    );
    
    res.json({ 
      id: result.rows[0].id, 
      coadminId,
      login_password: autoPassword,
      greeting: autoGreeting,
      generated: {
        industryQuestions: generated.industryQuestions || [],
        followUpTriggers: generated.followUpTriggers || {},
        standardRoutines: generated.standardRoutines || [],
      }
    });
  } catch(err) {
    console.error('Create company error:', err);
    res.status(500).json({ error: err.message || 'Feil ved opprettelse av selskap' });
  }
});

// GET /api/brreg/lookup/:orgNumber — look up company info from Brreg
  app.get('/api/brreg/lookup/:orgNumber', async (req, res) => {
    try {
      const { lookupBrregCompany } = require('./registry-lookup');
      const info = await lookupBrregCompany(req.params.orgNumber);
      if (!info) return res.status(404).json({ error: 'Selskap ikke funnet i Brønnøysundregisteret' });
      
      const { enrichCompanyFromBrreg } = require('./auto-company-generator');
      const enriched = await enrichCompanyFromBrreg(req.params.orgNumber);
      
      res.json({ brreg: info, enriched });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // GET /api/brreg/search?name=... — search companies by name
  app.get('/api/brreg/search', async (req, res) => {
    try {
      const { searchBrregCompany } = require('./registry-lookup');
      const results = await searchBrregCompany(req.query.name);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

// Generate random password
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const specials = '!#@$';
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random()*chars.length)];
  pw += specials[Math.floor(Math.random()*specials.length)];
  pw += Math.floor(Math.random()*90+10);
  return pw;
}

// Update company
app.patch('/api/companies/:id', async (req, res) => {
  const fields = req.body;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = Object.values(fields);
  const idIdx = keys.length + 1;
  await db.run(`UPDATE companies SET ${sets} WHERE id = $${idIdx}`, ...vals, req.params.id);
  res.json({ success: true });
});

// Upload company logo (base64)
app.post('/api/companies/:id/logo', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { logo_data } = req.body; // base64 data URL
    if (!logo_data) return res.status(400).json({ error: 'logo_data påkrevd' });
    
    const company = await db.get('SELECT * FROM companies WHERE id = $1', req.params.id);
    if (!company) return res.status(404).json({ error: 'Selskap ikke funnet' });
    
    // Decode base64 and save as file
    const matches = logo_data.match(/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Ugyldig bildeformat' });
    
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1] === 'svg+xml' ? 'svg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `company-${req.params.id}-logo.${ext}`;
    const filepath = path.join(__dirname, 'public', filename);
    
    fs.writeFileSync(filepath, buffer);
    const logo_url = `/crm/${filename}`;
    
    await db.run('UPDATE companies SET logo_url = $1 WHERE id = $2', logo_url, req.params.id);
    res.json({ success: true, logo_url });
  } catch (err) {
    console.error('Logo upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Shareable transcript page
app.get('/api/calls/:id/transcript', async (req, res) => {
  try {
    const call = await db.get('SELECT c.*, cu.name as customer_name, co.name as company_name FROM calls c LEFT JOIN customers cu ON c.customer_id = cu.id LEFT JOIN companies co ON c.company_id = co.id WHERE c.id = $1', req.params.id);
    if (!call) return res.status(404).send('Samtale ikke funnet');
    
    const transcript = call.transcript || 'Ingen transkripsjon tilgjengelig';
    const html = `<!DOCTYPE html>
<html lang="no"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Samtale #${call.id} - ${call.company_name || 'COE'}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:700px;margin:0 auto;padding:20px;background:#0f172a;color:#e2e8f0;}
  h1{color:#38bdf8;font-size:1.3rem;}
  .meta{color:#94a3b8;font-size:.85rem;margin-bottom:1rem;padding:.75rem;background:#1e293b;border-radius:.5rem;}
  .transcript{background:#1e293b;padding:1rem;border-radius:.5rem;line-height:1.6;white-space:pre-wrap;font-size:.9rem;}
  .ai{color:#34d399;} .user{color:#60a5fa;}
  .recording{margin:1rem 0;} audio{width:100%;border-radius:.5rem;}
  .badge{display:inline-block;padding:.15rem .5rem;border-radius:1rem;font-size:.7rem;margin-left:.5rem;}
  .badge-ok{background:#166534;color:#86efac;} .badge-fail{background:#7f1d1d;color:#fca5a5;}
</style></head><body>
<h1>📞 Samtale #${call.id} <span class="badge ${call.call_outcome==='booking'?'badge-ok':'badge-fail'}">${call.call_outcome||'ukjent'}</span></h1>
<div class="meta">
  <strong>Selskap:</strong> ${call.company_name||'-'}<br>
  <strong>Kunde:</strong> ${call.customer_name||'-'}<br>
  <strong>Dato:</strong> ${call.created_at ? new Date(call.created_at).toLocaleString('no-NO') : '-'}<br>
  <strong>Varighet:</strong> ${call.call_duration ? Math.round(call.call_duration/60)+'m '+call.call_duration%60+'s' : '-'}
</div>
${call.recording_url ? `<div class="recording"><strong>🎙️ Lydopptak:</strong><br><audio controls src="${call.recording_url}"></audio></div>` : ''}
<div class="transcript">${transcript.replace(/AI:/g,'<span class="ai">AI:</span>').replace(/User:|Kunde:/g,'<span class="user">Kunde:</span>')}</div>
</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send('Feil: ' + err.message);
  }
});

// Fetch recordings from Vapi for specific calls
app.post('/api/admin/fetch-recordings', async (req, res) => {
  try {
    const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
    if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler' });
    
    const callsWithoutRecording = await db.all("SELECT id, vapi_call_id FROM calls WHERE recording_url IS NULL AND vapi_call_id IS NOT NULL ORDER BY id DESC LIMIT 20");
    const results = [];
    
    for (const call of callsWithoutRecording) {
      try {
        const vapiResp = await fetch(`https://api.vapi.ai/call/${call.vapi_call_id}`, {
          headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
        });
        const vapiData = await vapiResp.json();
        const recordingUrl = vapiData.recordingUrl || vapiData.artifact?.recordingUrl || null;
        
        if (recordingUrl) {
          await db.run('UPDATE calls SET recording_url = $1 WHERE id = $2', recordingUrl, call.id);
          results.push({ callId: call.id, recordingUrl, status: 'updated' });
        } else {
          results.push({ callId: call.id, status: 'no_recording' });
        }
      } catch (e) {
        results.push({ callId: call.id, status: 'error', error: e.message });
      }
    }
    
    res.json({ checked: callsWithoutRecording.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete company (cascading)
app.delete('/api/companies/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await db.run('DELETE FROM bookings WHERE company_id = $1', id);
    await db.run('DELETE FROM call_sessions WHERE company_id = $1', id);
    await db.run('DELETE FROM calls WHERE company_id = $1', id);
    await db.run('DELETE FROM customers WHERE company_id = $1', id);
    await db.run('DELETE FROM coe_prompt_improvements WHERE company_id = $1', id);
    await db.run('DELETE FROM companies WHERE id = $1', id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete company error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== CHATBOT WEBHOOK (Base44 / external chatbots) =====
app.post('/api/chatbot-booking', async (req, res) => {
  try {
    const { company_id, name, phone, address, service, preferred_date, preferred_time, comment, transcript, source } = req.body;
    if (!company_id || !name) return res.status(400).json({ error: 'company_id og name er påkrevd' });

    const company = await db.get('SELECT * FROM companies WHERE id = $1', company_id);
    if (!company) return res.status(404).json({ error: 'Selskap ikke funnet' });

    // Lagre kunde
    const result = await db.run(
      `INSERT INTO customers (company_id, name, phone, address, service_requested, preferred_date, preferred_time, comment, status, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Ny', $9, NOW()) RETURNING id`,
      company_id, name, phone || null, address || null, service || null,
      preferred_date || null, preferred_time || null, comment || null,
      source || 'Chatbot'
    );
    const customerId = result.rows[0].id;
    const customer = await db.get('SELECT * FROM customers WHERE id = $1', customerId);

    // Lagre samtale-logg
    if (transcript) {
      await db.run(
        `INSERT INTO calls (customer_id, company_id, transcript, status, call_outcome, created_at)
         VALUES ($1, $2, $3, 'completed', 'bestilling', NOW())`,
        customerId, company_id, transcript
      );
    }

    // === SMS CASCADE (alle 3, avhengig av toggles) ===
    // 1. Uttrekk-SMS til ansatt (AI-oppsummering)
    if (company.sms_extract_employee !== false && company.montour_phone && transcript) {
      await sendExtractionSms(transcript, customer, company);
    }
    // 2. Bekreftelse-SMS til kunde
    if (company.sms_confirm_customer !== false && customer.phone) {
      await sendBookingConfirmation(customer, company);
    }
    // 3. Montør-varsel (info om ny bestilling)
    if (company.sms_notify_worker !== false && company.montour_phone) {
      await sendToMontour(customer, company);
    }
    // Påminnelse planlegges automatisk av cron-jobben i sms-handler.js

    console.log(`✅ Chatbot-booking: ${name} for ${company.name} (ID: ${customerId}, kilde: ${source || 'Chatbot'})`);
    res.json({ success: true, customerId, message: 'Bestilling registrert, SMS sendt' });
  } catch (e) {
    console.error('❌ Chatbot-booking feil:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get conversion stats
app.get('/api/stats', async (req, res) => {
  // Total calls (from calls table)
  const totalCallsRow = await db.get('SELECT COUNT(*) as count FROM calls');
  const totalCalls = parseInt(totalCallsRow.count);
  
  // Call outcomes
  const bookingCallsRow = await db.get("SELECT COUNT(*) as count FROM calls WHERE call_outcome = 'booking'");
  const bookingCalls = parseInt(bookingCallsRow.count);
  const noBookingRow = await db.get("SELECT COUNT(*) as count FROM calls WHERE call_outcome IN ('no_booking', 'hung_up', 'declined')");
  const noBookingCalls = parseInt(noBookingRow.count);
  const hangupRow = await db.get("SELECT COUNT(*) as count FROM calls WHERE call_outcome IN ('hangup', 'busy', 'failed', 'no_answer', 'canceled')");
  const hangupCalls = parseInt(hangupRow.count);
  const errorRow = await db.get("SELECT COUNT(*) as count FROM calls WHERE error_flag = true");
  const errorCalls = parseInt(errorRow.count);
  
  // Customer stats
  const totalRow = await db.get('SELECT COUNT(*) as count FROM customers');
  const total = parseInt(totalRow.count);
  const booketRow = await db.get("SELECT COUNT(*) as count FROM customers WHERE status IN ('Booket', 'Inngått avtale', 'Fullført', 'Betalt')");
  const booket = parseInt(booketRow.count);
  const inngattRow = await db.get("SELECT COUNT(*) as count FROM customers WHERE status = 'Inngått avtale'");
  const inngatt = parseInt(inngattRow.count);
  const fullfortRow = await db.get("SELECT COUNT(*) as count FROM customers WHERE status IN ('Fullført', 'Betalt')");
  const fullfort = parseInt(fullfortRow.count);
  const betaltRow = await db.get("SELECT COUNT(*) as count FROM customers WHERE status = 'Betalt'");
  const betalt = parseInt(betaltRow.count);
  const avbestiltRow = await db.get("SELECT COUNT(*) as count FROM customers WHERE status = 'Avbestilt'");
  const avbestilt = parseInt(avbestiltRow.count);
  
  res.json({
    totalCalls,
    bookingCalls,
    noBookingCalls,
    hangupCalls,
    errorCalls,
    bookingCallRate: totalCalls > 0 ? ((bookingCalls / totalCalls) * 100).toFixed(1) : 0,
    total,
    booket,
    inngatt,
    fullfort,
    betalt,
    avbestilt,
    bookingRate: total > 0 ? ((booket / total) * 100).toFixed(1) : 0,
    fullforingsRate: booket > 0 ? ((fullfort / booket) * 100).toFixed(1) : 0,
    betalingsRate: booket > 0 ? ((betalt / booket) * 100).toFixed(1) : 0,
  });
});

// Revenue stats
app.get('/api/stats/revenue', async (req, res) => {
  const byMonth = await db.all(`
    SELECT TO_CHAR(created_at, 'YYYY-MM') as month, 
           SUM(price) as revenue, COUNT(*) as count
    FROM customers WHERE price > 0
    GROUP BY month ORDER BY month DESC LIMIT 12
  `);
  
  const byCompany = await db.all(`
    SELECT co.name, SUM(c.price) as revenue, COUNT(*) as count
    FROM customers c JOIN companies co ON c.company_id = co.id
    WHERE c.price > 0
    GROUP BY c.company_id, co.name ORDER BY revenue DESC
  `);
  
  const byMontour = await db.all(`
    SELECT montour_name, SUM(price) as revenue, COUNT(*) as count
    FROM customers WHERE price > 0 AND montour_name IS NOT NULL
    GROUP BY montour_name ORDER BY revenue DESC
  `);
  
  res.json({ byMonth, byCompany, byMontour });
});

// ===============================================================
// 6. CHAT API - Text-based AI conversation (same GPT-4o as calls)
// ===============================================================
const chatSessions = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { companyId, sessionId, message } = req.body;

    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    const company = await db.get('SELECT * FROM companies WHERE id = $1', companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // New session — return greeting
    if (!sessionId) {
      const newSessionId = uuidv4();
      const greeting = company.greeting || `Hei! Velkomen til ${company.name}. Kva kan eg hjelpe deg med?`;
      const session = {
        id: newSessionId,
        company_id: companyId,
        state: 'greeting',
        collected_data: '{}',
        conversation_history: JSON.stringify([
          { role: 'assistant', content: JSON.stringify({ response: greeting, collected: {}, complete: false, summary: null }) }
        ])
      };
      chatSessions.set(newSessionId, session);

      return res.json({
        sessionId: newSessionId,
        response: greeting,
        collectedData: {},
        complete: false
      });
    }

    // Existing session — process message
    let session = chatSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log('Chat processing message for company:', company.name, 'industry:', company.industry);
    console.log('Session data:', { collected: session.collected_data, historyLen: JSON.parse(session.conversation_history || '[]').length });
    // Load active auto-learned improvements for this company
    const chatImprovements = pool ? await getActiveImprovements(pool, company.id) : [];
    const result = await processMessage(company, session, message, chatImprovements);
    console.log('Chat result:', { response: result.response?.substring(0, 100), complete: result.complete });

    // Update session in memory
    session.collected_data = JSON.stringify(result.collectedData);
    session.conversation_history = JSON.stringify(result.conversationHistory);
    session.state = result.complete ? 'complete' : 'collecting';
    chatSessions.set(sessionId, session);

    // If conversation is complete — save customer to DB and send SMS
    let savedCustomer = null;
    if (result.complete) {
      try {
        const data = result.collectedData;
        const industryFields = {};
        for (const [key, val] of Object.entries(data)) {
          if (!['navn', 'adresse', 'telefon', 'dato', 'klokkeslett', 'problem'].includes(key)) {
            industryFields[key] = val;
          }
        }
        const postalMatch = (data.adresse || '').match(/\b(\d{4})\b/);
        const postalCode = postalMatch ? postalMatch[1] : null;

        const customerResult = await db.run(`
          INSERT INTO customers (company_id, name, phone, address, preferred_date, preferred_time, postal_code, service_requested, status, industry_data, comment, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Booket', $9, $10, 'Telefon')
          RETURNING id
        `,
          company.id,
          data.navn || '',
          data.telefon || '',
          data.adresse || '',
          data.dato || '',
          data.klokkeslett || '',
          postalCode,
          data.problem || result.summary || '',
          JSON.stringify(industryFields),
          result.summary || ''
        );

        savedCustomer = { id: customerResult.rows[0].id };

        // Parse and save structured availability
        const availText = [data.dato, data.klokkeslett].filter(Boolean).join(' ');
        const availSlots = parseAvailabilityText(availText);
        if (availSlots.length > 0) {
          await db.run('UPDATE customers SET availability_json = $1 WHERE id = $2',
            JSON.stringify(availSlots), savedCustomer.id);
        }

        // Send SMS to montør if company has one
        const freshCustomer = await db.get('SELECT * FROM customers WHERE id = $1', savedCustomer.id);
        if (company.montour_phone) {
          await sendToMontour(freshCustomer, company);
        }

        // Send bestillingsbekreftelse til kunden
        if (freshCustomer.phone) {
          await sendBookingConfirmation(freshCustomer, company);
        }

        // Uttrekk-SMS fra chat-samtale
        if (company.sms_extract_employee !== false) {
          const chatTranscript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
          if (chatTranscript) {
            await sendExtractionSms(chatTranscript, freshCustomer, company);
          }
        }

        console.log(`✅ Chat: Customer saved (ID: ${savedCustomer.id}) and SMS sent`);
      } catch (saveErr) {
        console.error('❌ Chat: Failed to save customer:', saveErr.message);
      }
    }

    res.json({
      sessionId,
      response: result.response,
      collectedData: result.collectedData || {},
      complete: result.complete || false,
      customerId: savedCustomer?.id || null
    });
  } catch (err) {
    console.error('Chat API error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error', detail: err?.message || 'unknown' });
  }
});

// ===============================================================
// 6b. OPENAI DEBUG TEST
// ===============================================================
app.get('/api/test-openai', async (req, res) => {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Du er en test-assistent. Svar kort med JSON: {"response": "Hei!", "collected": {}, "complete": false, "summary": null}' },
        { role: 'user', content: 'Hei' }
      ],
      temperature: 0.7,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });
    res.json({ success: true, result: completion.choices[0].message.content });
  } catch(e) {
    res.json({ success: false, error: e?.message, status: e?.status, code: e?.code, type: e?.type });
  }
});

// ===============================================================
// 7. AUTH API - Login for CRM
// ===============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Coe#Adm!n2024xQ';

// Server-side lockout: 2 attempts then permanent lock per IP
const _lockoutMap = new Map(); // ip -> { attempts, locked }

app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';

  if (!password) {
    return res.status(400).json({ success: false, error: 'Password is required' });
  }

  // Check lockout
  const state = _lockoutMap.get(ip) || { attempts: 0, locked: false };
  if (state.locked) {
    return res.status(403).json({ success: false, error: 'Kontoen er sperret. Kontakt admin for å oppheve.', locked: true });
  }

  const userAgent = req.headers['user-agent'] || 'unknown';

  // Check admin password
  if (password === ADMIN_PASSWORD) {
    _lockoutMap.delete(ip);
    try { await pool.query('INSERT INTO login_log (ip, success, company_name, is_admin, user_agent) VALUES ($1, true, $2, true, $3)', [ip, 'Administrator', userAgent]); } catch(e) {}
    return res.json({ success: true, companyId: null, companyName: 'Administrator', isAdmin: true });
  }

  // Check company passwords
  const companies = await db.all("SELECT id, name, login_password FROM companies WHERE login_password IS NOT NULL AND login_password != ''");
  for (const company of companies) {
    if (company.login_password === password) {
      _lockoutMap.delete(ip);
      try { await pool.query('INSERT INTO login_log (ip, success, company_name, is_admin, user_agent) VALUES ($1, true, $2, false, $3)', [ip, company.name, userAgent]); } catch(e) {}
      return res.json({ success: true, companyId: company.id, companyName: company.name, isAdmin: false });
    }
  }

  // Wrong password — log failed attempt
  try { await pool.query('INSERT INTO login_log (ip, success, company_name, is_admin, user_agent) VALUES ($1, false, $2, false, $3)', [ip, 'FEILET', userAgent]); } catch(e) {}

  // Wrong password — increment attempts
  state.attempts += 1;
  if (state.attempts >= 2) {
    state.locked = true;
    _lockoutMap.set(ip, state);
    return res.status(403).json({ success: false, error: 'Kontoen er sperret etter 2 forsøk. Kontakt admin for å oppheve.', locked: true });
  }
  _lockoutMap.set(ip, state);
  return res.status(401).json({ success: false, error: `Feil passord (${2 - state.attempts} forsøk gjenstår)` });
});

// Admin unlock endpoint — resets lockout for all IPs
app.post('/api/auth/unlock', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Ugyldig admin-nøkkel' });
  }
  const count = _lockoutMap.size;
  _lockoutMap.clear();
  res.json({ success: true, message: `Lockout nullstilt for ${count} IP-adresser` });
});

// ===============================================================
// START SERVER
// ===============================================================
(async () => {
  try {
    console.log('🚀 Starting Coe AI Voice Assistant...');
    await initDatabase();
    console.log('✅ Database ready!');
    
    // Start reminder scheduler
    startReminderScheduler(db);
    
    // Start self-monitoring health checks (every 15 min, SMS alerts on failure)
    startHealthMonitor(db);
    
    // 🛡️ Security — init tables, routes, daily audit cron
    await initSecurityTables(db);
    setupSecurityRoutes(app, db);
    startSecurityCrons(db);
    console.log('🛡️ Security monitor active!');

    // 💰 Cost monitor — init tables, daily cost check, alerts
    await initCostTables(db);
    startCostMonitor(db);
    console.log('💰 Cost monitor active!');

    // 📊 Monitoring — daily report, SMS limit, GitHub token (replaces Tasklet triggers)
    monitoring.init(pool);
    monitoring.registerRoutes(app);
    console.log('📊 Monitoring module active!');

    // ===== VAPI AUTO-RECOVERY — henter tapte samtaler fra Vapi hvert minutt =====
    // Definert globalt slik at debug-endepunkt kan kalle den
    global._vapiAutoRecovery = async function vapiAutoRecovery() {
      try {
        const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
        if (!VAPI_KEY) return;
        
        const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
        
        // Hent siste 20 samtaler fra Vapi
        const resp = await fetch('https://api.vapi.ai/call?limit=20', {
          headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
        });
        if (!resp.ok) return;
        const vapiCalls = await resp.json();
        
        for (const vc of vapiCalls) {
          if (vc.status !== 'ended') continue;
          
          // Sjekk om allerede lagret
          const existing = await db.query(
            'SELECT id FROM calls WHERE twilio_call_sid = $1',
            [`vapi_${vc.id}`]
          );
          if (existing.rows.length > 0) continue;
          
          // Finn selskap via assistant ID
          const companyResult = await db.query(
            'SELECT id, name, requires_worker_approval FROM companies WHERE vapi_assistant_id = $1',
            [vc.assistantId]
          );
          const companyId = companyResult.rows.length > 0 ? companyResult.rows[0].id : null;
          if (!companyId) continue;
          
          const duration = vc.startedAt && vc.endedAt 
            ? Math.round((new Date(vc.endedAt) - new Date(vc.startedAt)) / 1000) 
            : 0;
          // Transcript: sjekk BÅDE vc.transcript OG vc.artifact.messages (OpenAI Realtime bruker artifact)
          const rawTranscript = vc.transcript || '';
          const artifactMessages = vc.artifact?.messages || [];
          const callerPhone = vc.customer?.number || 'ukjent';
          
          // Bygg transcript-tekst fra Vapi-format (MÅ være FØR outcome-sjekk!)
          let transcriptText = '';
          if (Array.isArray(rawTranscript) && rawTranscript.length > 0) {
            transcriptText = rawTranscript.map(t => `${t.role === 'assistant' ? 'AI' : 'Kunde'}: ${t.message || t.text || ''}`).join('\n');
          } else if (typeof rawTranscript === 'string' && rawTranscript.length > 0) {
            transcriptText = rawTranscript;
          }
          // Fallback: OpenAI Realtime lagrer transcript i artifact.messages
          if (!transcriptText && artifactMessages.length > 0) {
            transcriptText = artifactMessages
              .filter(m => m.role === 'assistant' || m.role === 'user')
              .map(m => `${m.role === 'assistant' ? 'AI' : 'Kunde'}: ${m.message || m.content || m.text || ''}`)
              .join('\n');
            console.log(`[RECOVERY] Brukte artifact.messages for transcript: ${transcriptText.length} tegn`);
          }
          
          // Smart outcome (NÅ etter transcriptText er bygget!)
          let outcome = 'hangup';
          if (duration < 10) { outcome = 'hangup'; }
          else if (duration >= 10 && transcriptText.length < 100) { outcome = 'hangup'; }
          // Settes senere basert på GPT-ekstraksjon (isBooking/har nok info)
          
          const recordingUrl = vc.recordingUrl || vc.artifact?.recordingUrl || vc.artifact?.stereoRecordingUrl || 
            vc.artifact?.videoRecordingUrl || vc.messages?.find(m => m.recordingUrl)?.recordingUrl ||
            vc.analysis?.recordingUrl || vc.monitor?.recordingUrl || null;
          if (!recordingUrl) {
            console.log(`⚠️ Recovery: Ingen recording URL funnet for ${vc.id}. Tilgjengelige nøkler:`, Object.keys(vc));
            if (vc.artifact) console.log('  artifact-nøkler:', Object.keys(vc.artifact));
          }
          
          // Normaliser datoer til YYYY-MM-DD — håndterer relative datoer, dagnavn, dialekt
          function normalizeDateToISO(dateStr) {
            if (!dateStr) return null;
            // Already ISO format
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
            
            const today = new Date();
            const dayOfWeek = today.getDay(); // 0=sunday
            const str = dateStr.toLowerCase().trim();
            
            // Map Norwegian day names (including dialects) to day numbers (1=mon..7=sun)
            const dayMap = {
              'mandag': 1, 'manda': 1, 'månda': 1,
              'tirsdag': 2, 'tisdag': 2, 'tirsdan': 2, 'tisdan': 2,
              'onsdag': 3, 'onsda': 3, 'onsta': 3,
              'torsdag': 4, 'tosdag': 4, 'torsdan': 4, 'tosdan': 4, 'tossda': 4,
              'fredag': 5, 'freda': 5, 'fredan': 5, 'frida': 5,
              'lørdag': 6, 'lauda': 6, 'lørda': 6,
              'søndag': 7, 'sønda': 7
            };
            
            // "i morgen" / "i morra"
            if (/i\s*(morgen|morra|mårra)/.test(str)) {
              const d = new Date(today); d.setDate(d.getDate() + 1);
              return d.toISOString().split('T')[0];
            }
            
            // "i dag" / "idag"
            if (/^i?\s*dag$/.test(str)) {
              return today.toISOString().split('T')[0];
            }
            
            // "om X dager/uker"
            const omMatch = str.match(/om\s+(\d+)\s*(dag|dager|uke|uker)/);
            if (omMatch) {
              const n = parseInt(omMatch[1]);
              const unit = omMatch[2].startsWith('uke') ? 7 : 1;
              const d = new Date(today); d.setDate(d.getDate() + n * unit);
              return d.toISOString().split('T')[0];
            }
            
            // "neste [dag]" or just "[dag]" — find next occurrence
            for (const [name, targetDay] of Object.entries(dayMap)) {
              if (str.includes(name)) {
                // JS: 0=sun, 1=mon... convert our 1=mon..7=sun to JS
                const jsTarget = targetDay === 7 ? 0 : targetDay;
                let daysAhead = jsTarget - dayOfWeek;
                if (daysAhead <= 0) daysAhead += 7; // Always next occurrence
                if (str.includes('neste') && daysAhead <= 7) daysAhead += 7; // "neste" = week after
                const d = new Date(today); d.setDate(d.getDate() + daysAhead);
                return d.toISOString().split('T')[0];
              }
            }
            
            // "neste uke" without specific day
            if (/neste\s*uke/.test(str)) {
              const daysToMon = (8 - dayOfWeek) % 7 || 7;
              const d = new Date(today); d.setDate(d.getDate() + daysToMon);
              return d.toISOString().split('T')[0];
            }
            
            // Norwegian date formats: "9. april", "niende april", etc
            const months = {'januar':1,'februar':2,'mars':3,'april':4,'mai':5,'juni':6,'juli':7,'august':8,'september':9,'oktober':10,'november':11,'desember':12};
            const dateMatch = str.match(/(\d{1,2})\.?\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)/);
            if (dateMatch) {
              const day = parseInt(dateMatch[1]);
              const month = months[dateMatch[2]];
              let year = today.getFullYear();
              if (month < today.getMonth() + 1 || (month === today.getMonth() + 1 && day < today.getDate())) year++;
              return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            }
            
            // DD/MM, DD.MM, DD-MM formats
            const numMatch = str.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
            if (numMatch) {
              const day = parseInt(numMatch[1]);
              const month = parseInt(numMatch[2]);
              let year = numMatch[3] ? parseInt(numMatch[3]) : today.getFullYear();
              if (year < 100) year += 2000;
              if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
              }
            }
            
            return dateStr; // Return as-is if no pattern matched
          }

          // Ekstraher navn fra transkripsjon som siste utvei
          function extractNameFromTranscript(transcript) {
            if (!transcript || transcript.length < 20) return null;
            // Common patterns: "mitt navn er X", "æ heite X", "je hete X", "det er X", "X her"
            const patterns = [
              /(?:mitt\s+)?navn\s+(?:er|e)\s+([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+)?)/i,
              /(?:æ|je|eg|ja)\s+(?:heite|hete|heter)\s+([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+)?)/i,
              /(?:de|det)\s+(?:er|e)\s+([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+)?)\s+(?:her|som\s+ringer)/i,
              /(?:hei|ja)\s+(?:de|det)\s+(?:er|e)\s+([A-ZÆØÅ][a-zæøå]+)/i,
            ];
            for (const p of patterns) {
              const m = transcript.match(p);
              if (m && m[1] && m[1].length >= 2) {
                const name = m[1].trim();
                const badNames = ['ny innringer','user','ukjent','unknown','hei','ja','nei','takk','ok'];
                if (!badNames.includes(name.toLowerCase())) return name;
              }
            }
            return null;
          }

          // 🔍 TRANSKRIPSJONS-KVALITETSSJEKK — detekterer søppel-transkripsjoner
          function isGarbageTranscript(text) {
            if (!text || text.length < 30) return true;
            const customerLines = text.split('\n').filter(l => l.startsWith('Kunde:') || l.startsWith('User:')).map(l => l.replace(/^(Kunde|User):\s*/, ''));
            const customerText = customerLines.join(' ');
            if (customerText.length < 10) return false; // Kun AI snakket — OK
            const words = customerText.toLowerCase().split(/\s+/).filter(w => w.length > 1);
            if (words.length < 3) return true;
            
            // CHECK 1: English-only detection (Norwegian speech mis-transcribed as English by OpenAI Realtime)
            const englishOnly = new Set(['the','they','them','this','that','yes','my','your','his','her','from','with','but','not','are','was','were','have','has','had','would','could','should','will','can','did','does','about','into','over','just','also','than','then','when','what','which','who','how','some','any','their','there','here','more','very','after','before','only','through','because','while','where','these','those','already','hello','hi','sorry','please','come','came','going','want','need','like','think','know','said','tell','told','okay','sure','right','well','good','thank','thanks','see','look','call','called','added','didn','don','isn','wasn','wouldn','couldn','son','sugar','heather','back','again','first','test','must','much','still','been','being','other','she','he','it','we','us','our','an','at','or','be','so','if','up','no','on','go','do','too','own','out','off','all','new','way','may','day','get','got','make','made','take','took','let','put','keep','kept','give','gave','try','run','say']);
            const norskMarkers = new Set(['ja','nei','hei','jeg','er','det','og','en','et','på','til','med','for','av','kan','har','vil','om','at','fra','den','de','som','meg','du','vi','ikke','hva','nå','bare','vel','men','så','vet','litt','alt','dag','takk','bra','ok','ønsker','trenger','bestille','time','avtale','navn','mitt','oss','dere','telefon','adresse','heter','heite','æ','je','mæ','ikkje','kor','ka','tja','jo','gjerne','tusen','fin','fint','stemmer','riktig','akkurat','også','skulle','gjerne','hjelp','snakke','dato','klokka','uke','morgen','ettermiddag','formiddag','kveld','mandag','tirsdag','onsdag','torsdag','fredag','lørdag','søndag']);
            
            const engCount = words.filter(w => englishOnly.has(w)).length;
            const norCount = words.filter(w => norskMarkers.has(w)).length;
            
            if (engCount >= 3 && norCount === 0 && words.length >= 5) {
              console.log(`🗑️ ENGLISH garbage detected! ${engCount} eng/${norCount} nor words. Text: "${customerText.substring(0, 200)}"`);
              return true;
            }
            if (engCount > norCount * 3 && engCount >= 4) {
              console.log(`🗑️ Mostly English garbage! ${engCount} eng/${norCount} nor words. Text: "${customerText.substring(0, 200)}"`);
              return true;
            }
            
            // CHECK 2: Repetitive/nonsense detection
            const commonWords = new Set(['ja','nei','hei','jeg','er','det','og','en','et','på','til','med','for','av','kan','har','vil','om','at','fra','den','de','som','meg','du','vi','ikke','hva','kor','ka','æ','je','mæ','ikkje','hjem','tak','takk','ok','tusen','bra','fint','ok','men','så','her','der','bare','vet','litt','nei','jo','vel','alt','alle','dag','nå','uke','hjelp','trenger','ønsker','bestille','time','avtale','dato','tid','nummer','adresse','navn','mitt','min','oss','dere','telefon','ringe','ringde','snakke','spørsmål','tjeneste','pris','betale','komme','se','gjøre','arbeid','jobb','problem','lekkasje','bad','kjøkken','tak','gulv','vegg','flis','rør','vann','varme','montør','rørlegger','frisør','klipp','farge','behandling','hår','salong','catering','mat','meny','selskap','bryllup','bursdag','arrangement','gjester','lokale','servering']);
            const knownCount = words.filter(w => commonWords.has(w) || w.length >= 3).length;
            const garbageRatio = 1 - (knownCount / words.length);
            const uniqueWords = new Set(words);
            const repetitionRatio = 1 - (uniqueWords.size / words.length);
            const isGarbage = (garbageRatio > 0.7 && words.length > 5) || (repetitionRatio > 0.6 && words.length > 4);
            if (isGarbage) {
              console.log(`🗑️ Søppel-transkripsjon! Garbage: ${(garbageRatio*100).toFixed(0)}%, Repetition: ${(repetitionRatio*100).toFixed(0)}%`);
            }
            return isGarbage;
          }
          
          // 🔄 WHISPER-FALLBACK — re-transkriber med Whisper hvis søppel-transkripsjon
          if (isGarbageTranscript(transcriptText) && recordingUrl) {
            console.log(`🎙️ Whisper-fallback: Re-transkriberer ${vc.id} fra lydopptak...`);
            try {
              const { OpenAI } = require('openai');
              const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
              // Last ned lydopptak
              const audioResp = await fetch(recordingUrl);
              if (audioResp.ok) {
                const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
                const fs = require('fs');
                const tmpPath = `/tmp/whisper_${vc.id}.mp3`;
                fs.writeFileSync(tmpPath, audioBuffer);
                // Transkriber med Whisper
                const whisperResp = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(tmpPath),
                  model: 'whisper-1',
                  language: 'no',
                  response_format: 'verbose_json'
                });
                if (whisperResp.text && whisperResp.text.length > 20) {
                  transcriptText = `Kunde: ${whisperResp.text}`;
                  console.log(`✅ Whisper-fallback OK: ${whisperResp.text.length} tegn transkript`);
                } else {
                  console.log(`⚠️ Whisper ga også kort resultat: "${whisperResp.text}"`);
                }
                // Rydd opp
                try { fs.unlinkSync(tmpPath); } catch(e) {}
              } else {
                console.log(`⚠️ Kunne ikke laste ned lydopptak: ${audioResp.status}`);
              }
            } catch (whisperErr) {
              console.error(`⚠️ Whisper-fallback feil:`, whisperErr.message);
            }
          }
          
          // GPT-ekstraksjon av kundedata fra transcript
          let extractedInfo = {};
          let isBooking = false;
          if (transcriptText && transcriptText.length > 50) {
            try {
              const { OpenAI } = require('openai');
              const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
              const extraction = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: `Du er verdens beste dataekstraktor for norske telefonsamtaler med ALLE dialekter + Deepgram STT-feil.

DATO: I dag er ${new Date().toLocaleDateString('no-NO', {weekday:'long',year:'numeric',month:'long',day:'numeric'})} (${new Date().toISOString().split('T')[0]}). Regn ut ALLE relative datoer!
- "neste torsdag/tosdan" = finn neste torsdag. "i morgen" = +1 dag. "på fredag/freda" = kommende fredag. "neste uke" = mandag neste uke.
- Dagnavn i dialekt: tosdan/torsdan/tossda=torsdag, onsda/onsta=onsdag, tirsdan/tisdan=tirsdag, freda/fredan/frida=fredag, manda/månda=mandag, lauda/lørda=lørdag, sønda=søndag.
- "om to uker" = +14 dager. "i neste uke" = neste mandag. "etter påske" = bruk kalender.
- Returner YYYY-MM-DD.

DIALEKT-TALL (grunntall):
- ein=1, to/tvo=2, tre=3, fire/før/fær=4, fem/fæm=5, seks/sæks=6, sju/sjø=7, åtte/otte=8, ni=9, ti=10.
- ølløv/ællæv/ælve=11, tålv/tølv=12, trættån=13, fjortån=14, fæmtån=15, sekstån=16, søttån=17, åttån=18, nittån=19.
- tjuge/tjue=20, tretti/trøtti=30, førti/førr=40, femti/fømti=50, seksti/sækksti=60, søtti=70, åtti/otti=80, nitti=90.
- Sammensatte: "å/og" = pluss. tuhundreååtteåfør=248, åttåfør=84, seksåfemti=650, sjunsækksti=76, hundreåseks=106, tuhundreåfemti=250.
- Postnr: "tjueseks førti"=2640, "tjueseks hundre"=2600, "tjuefem hundre"=2500.

ADRESSE-TOLKNING (ALLER VIKTIGST!):
Deepgram splitter ALLTID sammensatte norske adresser og legger til FEIL bynavn!
- "ruste Bergen" / "ruste vegen" = Rustevegen (ALDRI Bergen!)
- "ga'lvæga" / "galvegga" / "gard veggen" = Gardvegen
- "kjerring dokka" / "skjerring dokken" = Kjerringdokka
- "nedre gata" = Nedregata. "stor gata" = Storgata. "stasjon svegen" = Stasjonsvegen.
- "bjørke vegen" = Bjørkevegen. "furu vegen" = Furuvegen. "gran vegen" = Granvegen.
- "elve gata" = Elvegata. "kirke gata" = Kirkegata. "sjø gata" = Sjøgata. "skole gata" = Skolegata.
- "kvam svegen" = Kvamsvegen. "over gata" = Overgata. "lang gata" = Langgata.
- "sør gata" = Sørgata. "gammel vegen" = Gamlevegen. "myr vegen" = Myrvegen.
Gatetyper: væga/vægjen/veggen=vegen, gåta/gata=gata, bakka/bakken=bakken, dokka/dokken=dokka, haugen/haugjen=haugen, stien/stia=stien, svinga/svingen=svingen, lykkja/løkka=løkka, tunet/tuna=tunet, grenda=grenda, flata=flata, moen=moen, åsen=åsen, vollen=vollen, ringen=ringen, kroken=kroken.
REGEL: FJERN feilaktige bynavn (Bergen, Oslo, Trondheim) som Deepgram legger til!
REGEL: Sammensatte stedsnavn er ETT ord: "kjerring dokka" = "Kjerringdokka"

STEDSNAVN (Gudbrandsdal): Vinstra/vinra=Vinstra(2640), Hundorp/hunnorp=Hundorp(2643), Kvam=Kvam(2642), Ringebu/ringbu=Ringebu(2630), Fåvang=Fåvang(2634), Tretten/trettn=Tretten(2635), Øyer=Øyer(2636), Lillehammer/hammar=Lillehammer(2600-2619), Otta/otto=Otta(2670), Dombås=Dombås(2660), Gausdal/gausda=Gausdal(2651), Sjoa=Sjoa(2672), Lom=Lom(2686), Vågå=Vågå(2680).

NAVN-TOLKNING (KRITISK — ALDRI returner "Ny innringer"!):
- Hent ALLTID kundens navn fra transkriptet — det er DER det står!
- Typiske STT-feil: "franc" = Frank, "ola" = Ola, "bjørn" = Bjørn, "tårbjørn" = Torbjørn, "sjønn" = Jon/Jonn, "eigil" = Eigil.
- Navn med STT-støy: "mitt navn er [X]", "æ heite [X]", "je hete [X]", "de e [X]", "je er [X]" — hent [X]!
- Etternavn: farm-navn (Haugen, Moen, Bakken, Sletten), -sen navn (Hansen, Olsen, Larsen).
- Selv usikre navn → returner det du hører — "Ny innringer" er ALDRI akseptabelt!

DIALEKT-ORD: æ/je=jeg, mæ/me=meg, dæ/de=deg, ka/kva=hva, kor=hvor, ikkje/itj=ikke, heime=hjemme, tå=av, nåke/nå=noe, dom=de/dem, ho=hun, hitte=finne, sjå=se, au/å=også, berre/bære=bare.

Svar KUN med JSON: {name, address, postal_code, service_requested, preferred_date (YYYY-MM-DD), alternative_dates (kommaseparert hvis flere datoer nevnt, ellers null), preferred_time, preferred_employee, befaring (true/false), comment, is_booking (true=minst navn+dato ELLER navn+tjeneste), samtale_avbrutt (true=AI la på for tidlig/samtale brått slutt uten avslutningsfrase), arrangement_type (bryllup/bursdag/firmafest/begravelse/etc — kun catering), antall_gjester (tall), meny_onsker (hva slags mat), lokale (lokale-info)}
VIKTIG: name skal ALDRI være null/tom hvis kunden har sagt navnet sitt!` },
                  { role: 'user', content: transcriptText }
                ],
                temperature: 0
              });
              const jsonMatch = extraction.choices[0]?.message?.content?.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                extractedInfo = JSON.parse(jsonMatch[0]);
                // Normaliser dato til ISO
                if (extractedInfo.preferred_date) {
                  extractedInfo.preferred_date = normalizeDateToISO(extractedInfo.preferred_date);
                }
                isBooking = extractedInfo.is_booking === true;
                // Smart outcome basert på ekstraksjon
                if (isBooking && extractedInfo.name && (extractedInfo.preferred_date || extractedInfo.service_requested)) {
                  outcome = 'booking';
                } else if (transcriptText.length > 100 && !extractedInfo.name && !extractedInfo.preferred_date) {
                  outcome = 'avbrutt'; // Samtale hadde innhold men ble avbrutt før noe ble samlet
                } else if (transcriptText.length > 100) {
                  outcome = 'no_booking'; // Samtale gjennomført men ufullstendig
                }
              }
              console.log(`🔄 Recovery GPT-ekstraksjon (outcome: ${outcome}):`, JSON.stringify(extractedInfo));
              
              // 🗺️ Kartverket postal code validation
              if (extractedInfo.postal_code || extractedInfo.address) {
                try {
                  const registry = require('./registry-lookup');
                  if (extractedInfo.address && extractedInfo.postal_code) {
                    const lookup = await registry.lookupAddress(`${extractedInfo.address} ${extractedInfo.postal_code}`);
                    if (lookup && lookup.verified) {
                      console.log(`✅ Kartverket bekreftet: ${lookup.full}`);
                      extractedInfo.address = lookup.address;
                      extractedInfo.postal_code = lookup.postalCode;
                      extractedInfo.validated_city = lookup.city;
                    }
                  } else if (extractedInfo.postal_code) {
                    const postalLookup = await registry.lookupPostalCode(extractedInfo.postal_code);
                    if (postalLookup) {
                      extractedInfo.validated_city = postalLookup.city;
                      console.log(`✅ Postnummer ${extractedInfo.postal_code} = ${postalLookup.city}`);
                    } else {
                      console.log(`⚠️ Postnummer ${extractedInfo.postal_code} ikke funnet i Kartverket`);
                    }
                  }
                } catch(regErr) { console.log('⚠️ Kartverket-validering feilet:', regErr.message); }
              }
            } catch (gptErr) {
              console.error('🔄 Recovery GPT-feil:', gptErr.message);
            }
          }
          
          // Opprett eller finn kunde — ALDRI overskriv booking-data, lag NY booking per samtale
          let customerId = null;
          const customerName = extractedInfo.name || extractNameFromTranscript(transcriptText) || 'Ny innringer';
          if (callerPhone !== 'ukjent') {
            // Sjekk om kunden allerede finnes (1 kunde per telefonnummer per selskap)
            const existingCust = await db.query(
              'SELECT id, name FROM customers WHERE phone = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1',
              [callerPhone, companyId]
            );
            if (existingCust.rows.length > 0) {
              customerId = existingCust.rows[0].id;
              // Oppdater KUN identitetsdata (navn, adresse) — ALDRI booking-data!
              const badNames = ['ny innringer', 'user', 'ukjent', 'unknown', 'test', 'testmann', 'innringer'];
              const isGoodNewName = customerName && !badNames.includes(customerName.toLowerCase()) && customerName.length >= 2;
              
              await db.query(
                `UPDATE customers SET 
                  name = CASE WHEN $1::text NOT IN ('Ny innringer','User','user','Ukjent','unknown') AND LENGTH($1::text) >= 2 AND name IN ('Ny innringer','User','user','Ukjent','unknown') THEN $1::text ELSE name END,
                  address = CASE WHEN $2::text IS NOT NULL AND LENGTH($2::text) > 2 AND (address IS NULL OR address = '') THEN $2::text ELSE address END,
                  postal_code = COALESCE(NULLIF($3::text, ''), postal_code),
                  updated_at = NOW()
                 WHERE id = $4`,
                [customerName, extractedInfo.address || null, extractedInfo.postal_code || null, customerId]
              );
              console.log(`🔄 Recovery: Oppdaterte kundeidentitet ${customerId} (${existingCust.rows[0].name} → ${isGoodNewName ? customerName : 'beholdt'})`);
            } else {
              // Ny kunde — kun identitetsdata
              const custResult = await db.query(
                `INSERT INTO customers (company_id, name, phone, address, postal_code, status, source, created_at)
                 VALUES ($1, $2, $3, $4, $5, 'Ny', 'Telefon', $6) RETURNING id`,
                [companyId, customerName, callerPhone, extractedInfo.address || null, extractedInfo.postal_code || null, vc.startedAt]
              );
              customerId = custResult.rows[0].id;
              console.log(`🔄 Recovery: Ny kunde ${customerId} — ${customerName}`);
            }
          }
          
          // Sett transkripsjons-kvalitet
          const transcriptQuality = isGarbageTranscript(transcriptText) ? 'garbage' : 'ok';
          
          // Lagre samtalen
          const callResult = await db.query(
            `INSERT INTO calls (customer_id, company_id, twilio_call_sid, duration_seconds, transcript, audio_url, status, call_outcome, call_duration, extracted_info, transcript_quality, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $4, $8, $9, $10) RETURNING id`,
            [customerId, companyId, `vapi_${vc.id}`, duration, transcriptText, recordingUrl, outcome, JSON.stringify(extractedInfo), transcriptQuality, vc.startedAt]
          );
          const callId = callResult.rows[0].id;
          
          // Opprett booking for denne samtalen (1 booking per samtale)
          if (customerId) {
            const commentParts = [extractedInfo.comment, extractedInfo.alternative_dates ? `Alt. datoer: ${extractedInfo.alternative_dates}` : null, extractedInfo.befaring ? 'Befaring ønsket' : null, extractedInfo.preferred_employee ? `Ønsket ansatt: ${extractedInfo.preferred_employee}` : null, extractedInfo.samtale_avbrutt ? '⚠️ Samtale avbrutt' : null].filter(Boolean).join('. ') || null;
            
            // Calculate end_time from preferred_time + duration
            let bookingEndTime = null;
            if (extractedInfo.preferred_time) {
              const timeParts = extractedInfo.preferred_time.replace('.', ':').split(':');
              const startMins = parseInt(timeParts[0]) * 60 + (parseInt(timeParts[1]) || 0);
              const endMins = startMins + 60; // default 60 min
              const endH = Math.floor(endMins / 60);
              const endM = endMins % 60;
              bookingEndTime = `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`;
            }
            
            await db.query(
              `INSERT INTO bookings (customer_id, company_id, call_id, service_requested, preferred_date, preferred_time, preferred_employee, comment, source, status, confirmation_status, duration_minutes, end_time)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Telefon', $9, $10, 60, $11)`,
              [customerId, companyId, callId, extractedInfo.service_requested || null, extractedInfo.preferred_date || null,
               extractedInfo.preferred_time || null, extractedInfo.preferred_employee || null, commentParts,
               isBooking ? 'Ny' : 'Henvendelse',
               companyResult.rows[0]?.requires_worker_approval === false ? 'confirmed' : 'pending',
               bookingEndTime]
            );
            console.log(`📋 Recovery: Booking opprettet for call ${callId} — ${extractedInfo.service_requested || 'ukjent tjeneste'}`);
          
          // Auto-confirm: update status + send confirmation SMS when requires_worker_approval is OFF
          if (companyResult.rows[0]?.requires_worker_approval === false && callerPhone !== 'ukjent') {
            // Oppdater kunde-status til Booket
            await db.query(`UPDATE customers SET status = 'Booket' WHERE id = $1`, [customerId]);
            try {
              const fullComp = (await db.query('SELECT * FROM companies WHERE id = $1', [companyId])).rows[0];
              const custName = extractedInfo.name ? ' ' + extractedInfo.name.split(' ')[0] : '';
              const dateText = extractedInfo.preferred_date || '';
              const timeText = extractedInfo.preferred_time ? ` kl ${extractedInfo.preferred_time}` : '';
              const svcText = extractedInfo.service_requested ? `\nTjeneste: ${extractedInfo.service_requested}` : '';
              const confirmMsg = `Hei${custName}! Din bestilling hos ${fullComp.name} er bekreftet! ✅\n📅 ${dateText}${timeText}${svcText}\nVi gleder oss til å se deg! 😊`;
              const { sendSms: confirmSmsFn } = require('./sms-handler');
              const confirmSms = await confirmSmsFn(callerPhone, confirmMsg, fullComp.name, { customerId, companyId, recipientType: 'customer', messageType: 'booking_confirmation' });
              if (confirmSms) console.log(`✅ Auto-bekreftet booking + SMS sendt til ${callerPhone}`);
            } catch (confirmErr) { console.error('Auto-confirm SMS feil:', confirmErr.message); }
          }
          // Auto-bekreftelse: "Vi kommer tilbake TIL DEG" — KUN når manuell bekreftelse er PÅ
          if (companyResult.rows[0]?.requires_worker_approval === true && callerPhone !== 'ukjent') {
            try {
              const fullComp2 = (await db.query('SELECT * FROM companies WHERE id = $1', [companyId])).rows[0];
              if (fullComp2?.feature_auto_confirm !== false) {
                const custName2 = extractedInfo.name ? ' ' + extractedInfo.name.split(' ')[0] : '';
                const autoMsg = `Hei${custName2}! Takk for samtalen med ${fullComp2.name}. Vi kommer tilbake TIL DEG med bekreftelse. Ha en fin dag! 😊`;
                const { sendSms: autoSmsFn } = require('./sms-handler');
                const autoRes = await autoSmsFn(callerPhone, autoMsg, fullComp2.name, { customerId, companyId, recipientType: 'customer', messageType: 'auto_confirm' });
                if (autoRes) console.log(`📨 Recovery: Auto-bekreftelse sendt til ${callerPhone}`);
              }
            } catch (autoSmsErr) { console.error('Recovery auto-bekreftelse SMS feil:', autoSmsErr.message); }
          }
          }
          
          // Send SMS til ansatt (kun for nye samtaler) — via sms-handler for logging + Sveve fallback
          const company = companyResult.rows[0];
          if (company && transcriptText) {
            try {
              const fullCompany = (await db.query('SELECT * FROM companies WHERE id = $1', [companyId])).rows[0];
              if (fullCompany?.sms_extract_employee !== false && (fullCompany.montour_phone || fullCompany.boss_phone)) {
                const targetPhone = fullCompany.montour_phone || fullCompany.boss_phone;
                const parts = [`📞 Ny kunde venter! — ${fullCompany.name}`];
                if (extractedInfo.name) parts.push(`Navn: ${extractedInfo.name}`);
                parts.push(`Tlf: ${callerPhone}`);
                if (extractedInfo.service_requested) parts.push(`Tjeneste: ${extractedInfo.service_requested}`);
                if (extractedInfo.address) parts.push(`Adresse: ${extractedInfo.address}${extractedInfo.postal_code ? ' ' + extractedInfo.postal_code : ''}`);
                if (extractedInfo.preferred_date) parts.push(`Dato: ${extractedInfo.preferred_date}`);
                if (extractedInfo.alternative_dates) parts.push(`Alt. datoer: ${extractedInfo.alternative_dates}`);
                if (extractedInfo.preferred_time) parts.push(`Tid: ${extractedInfo.preferred_time}`);
                if (extractedInfo.preferred_employee) parts.push(`Ønsket ansatt: ${extractedInfo.preferred_employee}`);
                if (extractedInfo.arrangement_type) parts.push(`Arrangement: ${extractedInfo.arrangement_type}`);
                if (extractedInfo.antall_gjester) parts.push(`Antall gjester: ${extractedInfo.antall_gjester}`);
                if (extractedInfo.meny_onsker) parts.push(`Meny: ${extractedInfo.meny_onsker}`);
                if (extractedInfo.lokale) parts.push(`Lokale: ${extractedInfo.lokale}`);
                if (extractedInfo.comment) parts.push(`Kommentar: ${extractedInfo.comment}`);
                const { sendSms: workerSmsFn } = require('./sms-handler');
                const smsMsg = await workerSmsFn(targetPhone, parts.join('\n'), fullCompany.name, { customerId, companyId, recipientType: 'worker', messageType: 'uttrekk_employee' });
                if (smsMsg) console.log(`✅ Recovery SMS sendt til ${targetPhone}`);
              }
            } catch (smsErr) { console.error('Recovery SMS feil:', smsErr.message); }
          }
          
          console.log(`🔄 Vapi recovery: Lagret ${vc.id} for ${companyResult.rows[0].name} — ${customerName} (${outcome}, ${duration}s)`);
        }
      } catch (e) {
        console.error('⚠️ Vapi auto-recovery feil:', e.message);
      }
    }
    
    // 🔧 SELF-HEALING: Re-extract calls that have transcript but empty extracted_info, OR garbage transcripts with audio
    async function selfHealingReExtract() {
      try {
        // Også finn samtaler med søppel-transkripsjon som har lydopptak
        const brokenCalls = await db.query(
          `SELECT c.id, c.customer_id, c.transcript, c.company_id, c.audio_url, cu.phone 
           FROM calls c LEFT JOIN customers cu ON c.customer_id = cu.id
           WHERE (
             (c.transcript IS NOT NULL AND LENGTH(c.transcript) > 50 
              AND (c.extracted_info IS NULL OR c.extracted_info = '{}' OR LENGTH(c.extracted_info) < 5))
             OR
             (c.transcript IS NOT NULL AND c.audio_url IS NOT NULL AND c.transcript_quality = 'garbage')
             OR
             (c.transcript IS NOT NULL AND LENGTH(c.transcript) > 50 AND c.customer_id IN (SELECT id FROM customers WHERE name IN ('Ny innringer','User','user','Ukjent','unknown')))
           )
           AND c.self_healed_at IS NULL
           ORDER BY c.id DESC LIMIT 10`
        );
        if (brokenCalls.rows.length === 0) return;
        console.log(`🔧 Self-healing: ${brokenCalls.rows.length} samtaler trenger re-ekstraksjon`);
        
        for (const call of brokenCalls.rows) {
          try {
            const companyResult = await db.query('SELECT * FROM companies WHERE id = $1', [call.company_id]);
            if (!companyResult.rows.length) continue;
            const company = companyResult.rows[0];
            
            // Whisper-fallback for søppel-transkripsjoner i self-healing
            let transcriptToUse = call.transcript;
            if (call.audio_url && call.transcript) {
              // Sjekk om transkripsjonen er søppel
              const custLines = call.transcript.split('\n').filter(l => l.startsWith('Kunde:') || l.startsWith('User:')).map(l => l.replace(/^(Kunde|User):\s*/, ''));
              const custText = custLines.join(' ');
              const words = custText.toLowerCase().split(/\s+/).filter(w => w.length > 1);
              const uniqueWords = new Set(words);
              const isRepetitive = words.length > 4 && (1 - uniqueWords.size / words.length) > 0.6;
              if (isRepetitive || (call.transcript_quality === 'garbage')) {
                console.log(`🎙️ Self-healing Whisper for call ${call.id}...`);
                try {
                  const { OpenAI } = require('openai');
                  const openaiSH = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                  const audioResp = await fetch(call.audio_url);
                  if (audioResp.ok) {
                    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
                    const fs = require('fs');
                    const tmpPath = `/tmp/whisper_sh_${call.id}.mp3`;
                    fs.writeFileSync(tmpPath, audioBuffer);
                    const whisperResp = await openaiSH.audio.transcriptions.create({
                      file: fs.createReadStream(tmpPath),
                      model: 'whisper-1', language: 'no', response_format: 'verbose_json'
                    });
                    if (whisperResp.text && whisperResp.text.length > 20) {
                      transcriptToUse = `Kunde: ${whisperResp.text}`;
                      await db.query('UPDATE calls SET transcript = $1, transcript_quality = $2 WHERE id = $3', [transcriptToUse, 'whisper_recovered', call.id]);
                      console.log(`✅ Self-healing Whisper OK for call ${call.id}: ${whisperResp.text.length} tegn`);
                    }
                    try { fs.unlinkSync(tmpPath); } catch(e) {}
                  }
                } catch(wErr) { console.error(`Whisper self-healing feil:`, wErr.message); }
              }
            }
            
            // GPT-ekstraksjon
            const extractResp = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: `Ekstraher kundeinfo fra denne samtalen. Svar KUN med JSON: {"name":"...","address":"...","postal_code":"...","service_requested":"...","preferred_date":"YYYY-MM-DD","preferred_time":"...","preferred_employee":null,"befaring":false,"comment":"...","is_booking":true/false,"samtale_avbrutt":true/false}. Bruk null for manglende felt. Ekte navn fra samtalen, ALDRI "User" eller "Ny innringer".` },
                  { role: 'user', content: transcriptToUse.substring(0, 3000) }
                ],
                max_tokens: 300, temperature: 0
              })
            });
            const extractData = await extractResp.json();
            let extractedInfo = {};
            try { extractedInfo = JSON.parse(extractData.choices[0].message.content.replace(/```json?|```/g, '').trim()); } catch(e) {}
            // Normaliser dato til ISO
            if (extractedInfo.preferred_date) {
              extractedInfo.preferred_date = normalizeDateToISO(extractedInfo.preferred_date);
            }
            
            if (Object.keys(extractedInfo).length > 0) {
              // Oppdater calls med extracted_info
              await db.query('UPDATE calls SET extracted_info = $1 WHERE id = $2', [JSON.stringify(extractedInfo), call.id]);
              
              // Oppdater kunde med bedre data
              if (call.customer_id) {
                const badNames = ['ny innringer', 'user', 'ukjent', 'unknown', 'test', 'testmann', 'innringer', '(fra vapi recovery)'];
                const newName = extractedInfo.name;
                const isGoodName = newName && !badNames.includes(newName.toLowerCase()) && newName.length >= 2;
                
                await db.query(
                  `UPDATE customers SET 
                    name = CASE WHEN $1::text IS NOT NULL AND LENGTH($1::text) >= 2 AND $1::text NOT IN ('User','user','Ny innringer','Ukjent','unknown') AND name IN ('Ny innringer','User','user','Ukjent','unknown','(fra Vapi recovery)') THEN $1::text ELSE name END,
                    address = CASE WHEN $2::text IS NOT NULL AND LENGTH($2::text) > 2 AND (address IS NULL OR address = '') THEN $2::text ELSE address END,
                    postal_code = COALESCE(NULLIF($3::text, ''), postal_code),
                    service_requested = CASE WHEN $4::text IS NOT NULL AND LENGTH($4::text) > 2 AND (service_requested IS NULL OR service_requested = '' OR service_requested = '–') THEN $4::text ELSE service_requested END,
                    preferred_date = COALESCE(NULLIF($5::text, ''), preferred_date),
                    preferred_time = COALESCE(NULLIF($6::text, ''), preferred_time),
                    updated_at = NOW()
                   WHERE id = $7`,
                  [extractedInfo.name || null, extractedInfo.address || null, extractedInfo.postal_code || null,
                   extractedInfo.service_requested || null, extractedInfo.preferred_date || null, extractedInfo.preferred_time || null,
                   call.customer_id]
                );
              }
              
              // Send SMS hvis ikke allerede sendt
              const company2 = companyResult.rows[0];
              if (company2?.sms_extract_employee !== false && (company2.montour_phone || company2.boss_phone)) {
                const targetPhone = company2.montour_phone || company2.boss_phone;
                const parts = [`📞 Ny kunde (re-extract) — ${company2.name}`];
                if (extractedInfo.name) parts.push(`Navn: ${extractedInfo.name}`);
                if (call.phone) parts.push(`Tlf: ${call.phone}`);
                if (extractedInfo.service_requested) parts.push(`Tjeneste: ${extractedInfo.service_requested}`);
                if (extractedInfo.address) parts.push(`Adresse: ${extractedInfo.address}${extractedInfo.postal_code ? ' ' + extractedInfo.postal_code : ''}`);
                if (extractedInfo.preferred_date) parts.push(`Dato: ${extractedInfo.preferred_date}`);
                try {
                  const { sendSms: healSmsFn } = require('./sms-handler');
                  const smsMsg = await healSmsFn(targetPhone, parts.join('\n'), company2.name, { customerId: call.customer_id, companyId: call.company_id, recipientType: 'worker', messageType: 'uttrekk_employee' });
                  if (smsMsg) console.log(`✅ Self-healing SMS sendt for call ${call.id}`);
                } catch(smsErr) { console.error('Self-healing SMS feil:', smsErr.message); }
              }
              
              // Mark as self-healed to prevent re-processing
              await db.query('UPDATE calls SET self_healed_at = NOW() WHERE id = $1', [call.id]);
              console.log(`🔧 Self-healing: Call ${call.id} re-ekstrahert → ${extractedInfo.name || '?'}`);
            }
          } catch(callErr) { console.error(`Self-healing feil for call ${call.id}:`, callErr.message); }
        }
      } catch(e) { console.error('Self-healing feil:', e.message); }
    }
    
    // Kjør self-healing hvert 5. minutt
    setInterval(selfHealingReExtract, 5 * 60 * 1000);
    setTimeout(selfHealingReExtract, 30000); // Kjør 30 sek etter oppstart
    console.log('🔧 Self-healing re-extraction startet (hvert 5 min)');
    
    // ⚡ TURBO MODE — recovery hvert MINUTT for lynrask prosessering!
    setInterval(global._vapiAutoRecovery, 60 * 1000);
    // Kjør med en gang ved oppstart (etter 10 sek)
    setTimeout(global._vapiAutoRecovery, 10000);
    console.log('⚡ Vapi auto-recovery TURBO startet (hvert 1 min!)');

    // 📱 SMS CATCH-UP: Sender uttrekk-SMS for samtaler som aldri fikk det
    async function smsCatchUp() {
      try {
        // Finn samtaler fra SISTE 24 TIMER med transcript som ALDRI fikk uttrekk-SMS
        const missedCalls = await db.all(`
          SELECT c.id as call_id, c.customer_id, c.transcript, c.extracted_info, c.company_id,
                 cu.name, cu.phone,
                 co.name as company_name, co.montour_phone, co.boss_phone, co.sms_extract_employee
          FROM calls c
          JOIN customers cu ON c.customer_id = cu.id
          JOIN companies co ON c.company_id = co.id
          WHERE c.transcript IS NOT NULL AND LENGTH(c.transcript) > 50
          AND c.created_at > NOW() - INTERVAL '24 hours'
          AND co.sms_extract_employee != false
          AND (co.montour_phone IS NOT NULL OR co.boss_phone IS NOT NULL)
          AND c.id NOT IN (
            SELECT DISTINCT m.call_id FROM messages m WHERE m.message_type = 'uttrekk_employee' AND m.call_id IS NOT NULL
          )
          AND cu.id NOT IN (
            SELECT DISTINCT m.customer_id FROM messages m WHERE m.message_type = 'uttrekk_employee' AND m.status IN ('sent', 'failed') AND m.created_at > NOW() - INTERVAL '24 hours'
          )
          ORDER BY c.id DESC LIMIT 3
        `);
        
        if (missedCalls.length === 0) return;
        console.log(`📱 SMS catch-up: ${missedCalls.length} samtaler uten uttrekk-SMS`);
        
        for (const call of missedCalls) {
          try {
            if (!canSendSMS()) { console.log('⚠️ SMS daglig grense nådd — stopper catch-up'); break; }
            const targetPhone = call.montour_phone || call.boss_phone;
            if (!targetPhone) continue;
            
            let info = {};
            try { info = JSON.parse(call.extracted_info || '{}'); } catch(e) {}
            
            const parts = [`📞 Ny kunde venter! — ${call.company_name}`];
            if (info.name || call.name) parts.push(`Navn: ${info.name || call.name}`);
            if (call.phone) parts.push(`Tlf: ${call.phone}`);
            if (info.service_requested) parts.push(`Tjeneste: ${info.service_requested}`);
            if (info.address) parts.push(`Adresse: ${info.address}${info.postal_code ? ' ' + info.postal_code : ''}`);
            if (info.preferred_date) parts.push(`Dato: ${info.preferred_date}`);
            if (info.preferred_time) parts.push(`Tid: ${info.preferred_time}`);
            if (info.arrangement_type) parts.push(`Arrangement: ${info.arrangement_type}`);
            if (info.antall_gjester) parts.push(`Gjester: ${info.antall_gjester}`);
            if (info.meny_onsker) parts.push(`Meny: ${info.meny_onsker}`);
            if (info.comment) parts.push(`Kommentar: ${info.comment}`);
            
            const { sendSms: catchupSmsFn } = require('./sms-handler');
            const smsMsg = await catchupSmsFn(targetPhone, parts.join('\n'), call.company_name, { customerId: call.customer_id, companyId: call.company_id, recipientType: 'worker', messageType: 'uttrekk_employee' });
            if (smsMsg) {
              trackSMSSent();
              console.log(`✅ SMS catch-up sendt for call ${call.call_id}`);
            } else {
              console.log(`⚠️ SMS catch-up feilet for call ${call.call_id} — logget av sms-handler`);
            }
          } catch (smsErr) {
            console.error(`⚠️ SMS catch-up feil for call ${call.call_id}:`, smsErr.message);
          }
        }
      } catch (err) {
        console.error('⚠️ SMS catch-up feil:', err.message);
      }
    }
    // SMS catch-up hvert 10. minutt
    // ⚠️ SMS catch-up DEAKTIVERT — forårsaket Twilio-suspensjon ved DB-rensing
    // setInterval(smsCatchUp, 10 * 60 * 1000);
    // setTimeout(smsCatchUp, 60000);
    console.log('📱 SMS catch-up DEAKTIVERT (sikkerhetstiltak)');

    // Configure Twilio StatusCallback for all phone numbers (catches hangups)
    try {
      const twilioClient = require('twilio')(process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN, { accountSid: process.env.TWILIO_ACCOUNT_SID });
      const numbers = await twilioClient.incomingPhoneNumbers.list();
      for (const num of numbers) {
        if (!num.statusCallback || !num.statusCallback.includes('/twilio/call-status')) {
          await twilioClient.incomingPhoneNumbers(num.sid).update({
            statusCallback: `${BASE_URL}/twilio/call-status`,
            statusCallbackMethod: 'POST'
          });
          console.log(`✅ StatusCallback configured for ${num.phoneNumber}`);
        }
      }
    } catch (e) {
      console.error('⚠️ Could not configure Twilio StatusCallback:', e.message);
    }
  } catch (err) {
    console.error('⚠️ Database init failed:', err.message);
    console.error('   Server will start anyway — DB features may not work');
  }
  
  // ===== FUNCTION CALL HANDLERS FOR VAPI =====

  async function handleValidateAddress(args) {
    const { street, postal_code } = args;
    try {
      const { lookupPostalCode } = require('./registry-lookup');
      
      // First validate postal code
      const postalResult = await lookupPostalCode(postal_code);
      
      // Then try address search via Kartverket
      if (street) {
        const searchUrl = `https://ws.geonorge.no/adresser/v1/sok?sok=${encodeURIComponent(street)}&postnummer=${postal_code}&treffPerSide=3`;
        const resp = await fetch(searchUrl);
        const data = await resp.json();
        
        if (data.adresser && data.adresser.length > 0) {
          const addr = data.adresser[0];
          return JSON.stringify({
            valid: true,
            formatted_address: `${addr.adressetekst}, ${addr.postnummer} ${addr.poststed}`,
            street: addr.adressetekst,
            postal_code: addr.postnummer,
            postal_place: addr.poststed,
            municipality: addr.kommunenavn
          });
        }
      }
      
      // Fallback: just postal code lookup
      if (postalResult) {
        return JSON.stringify({
          valid: true,
          postal_code: postal_code,
          postal_place: postalResult.place || postalResult,
          note: street ? 'Adressen ble ikke funnet, men postnummeret er gyldig.' : 'Postnummer bekreftet.'
        });
      }
      
      return JSON.stringify({ valid: false, error: 'Postnummer ikke funnet' });
    } catch (err) {
      console.error('❌ Address validation error:', err.message);
      return JSON.stringify({ valid: false, error: err.message });
    }
  }

  async function handleLookupPostalCode(args) {
    try {
      const { lookupPostalCode } = require('./registry-lookup');
      const result = await lookupPostalCode(args.postal_code);
      if (result) {
        return JSON.stringify({ postal_code: args.postal_code, place: result.place || result, valid: true });
      }
      return JSON.stringify({ valid: false, error: 'Postnummer ikke funnet i registeret' });
    } catch (err) {
      return JSON.stringify({ valid: false, error: err.message });
    }
  }

  async function handleCheckServices(companyId, db) {
    try {
      if (!companyId) return JSON.stringify({ error: 'Ingen company ID' });
      const company = await db.get('SELECT name, industry, system_prompt FROM companies WHERE id = $1', companyId);
      if (!company) return JSON.stringify({ error: 'Selskap ikke funnet' });
      
      // Extract services from system_prompt if available
      const prompt = company.system_prompt || '';
      const serviceMatch = prompt.match(/(?:tjenester|services|tilbyr|tilbud)[:\s]*([^\n]+(?:\n[•\-\*][^\n]+)*)/i);
      
      return JSON.stringify({
        company: company.name,
        industry: company.industry,
        services_info: serviceMatch ? serviceMatch[0] : 'Se system_prompt for detaljer',
        note: 'Forklar tjenestene kort og naturlig til kunden.'
      });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // Cache for assistantId → companyId mapping
  const assistantCompanyCache = {};
  async function extractCompanyIdFromCall(payload) {
    const assistantId = payload?.message?.call?.assistantId || payload?.call?.assistantId;
    if (!assistantId) return null;
    if (assistantCompanyCache[assistantId]) return assistantCompanyCache[assistantId];
    try {
      const row = await db.get('SELECT id FROM companies WHERE vapi_assistant_id = $1', assistantId);
      if (row) { assistantCompanyCache[assistantId] = row.id; return row.id; }
    } catch(e) { console.error('extractCompanyId error:', e.message); }
    return null;
  }

  async function handleCheckCustomer(phone, companyId, dbConn) {
    try {
      if (!phone) return JSON.stringify({ returning: false, message: 'Ingen telefonnummer oppgitt' });
      // Normalize phone
      let p = phone.replace(/[\s\-\(\)]/g, '');
      if (!p.startsWith('+')) p = p.startsWith('47') && p.length === 10 ? '+' + p : '+47' + p;
      
      const customer = await dbConn.get(
        `SELECT cu.id, cu.name, cu.phone, COUNT(b.id) as booking_count, 
         MAX(b.service_request) as last_service, MAX(b.date_requested) as last_date
         FROM customers cu
         LEFT JOIN bookings b ON b.customer_id = cu.id
         WHERE cu.phone = $1 ${companyId ? 'AND cu.company_id = $2' : ''}
         GROUP BY cu.id, cu.name, cu.phone
         ORDER BY cu.id DESC LIMIT 1`,
        companyId ? [p, companyId] : [p]
      );
      
      if (customer && customer.name && customer.name !== 'Ny innringer') {
        return JSON.stringify({
          returning: true,
          name: customer.name,
          booking_count: customer.booking_count || 0,
          last_service: customer.last_service || null,
          last_date: customer.last_date || null,
          instruction: `Kunden heter ${customer.name} og har ringt ${customer.booking_count} gang(er) før. Si: "Hei ${customer.name}! Hyggelig å høre fra deg igjen. Gjelder dette en ny bestilling, eller handler det om noe vi har avtalt fra før?"`
        });
      }
      return JSON.stringify({ returning: false, message: 'Ny kunde — følg standard samtaleflyt' });
    } catch (err) {
      console.error('check_customer error:', err.message);
      return JSON.stringify({ returning: false, error: err.message });
    }
  }


  // ===== CHECK AVAILABILITY — AI function call =====
  async function handleCheckAvailability(companyId, dateStr) {
    try {
      const targetDate = dateStr || new Date().toISOString().split('T')[0];
      
      // Parse target date to get day of week
      const dateObj = new Date(targetDate + 'T12:00:00');
      const dayOfWeek = dateObj.getDay(); // 0=sunday
      const dayNames = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
      
      // 1. Get availability slots for this company on this day
      const availSlots = await db.all(
        `SELECT start_time, end_time, slot_duration FROM availability 
         WHERE company_id = $1 AND day_of_week = $2 AND is_active = true`,
        companyId, dayOfWeek
      );
      
      // If no availability defined for this day, the company is closed
      if (!availSlots.length) {
        // Check next 7 days for available days
        const nextAvail = await db.all(
          `SELECT DISTINCT day_of_week FROM availability 
           WHERE company_id = $1 AND is_active = true ORDER BY day_of_week`,
          companyId
        );
        
        if (!nextAvail.length) {
          return JSON.stringify({
            available: false,
            date: targetDate,
            message: 'Ingen ledige tider er satt opp ennå. Be kunden ringe tilbake eller kontakte oss direkte.'
          });
        }
        
        const availDays = nextAvail.map(a => dayNames[a.day_of_week]).join(', ');
        return JSON.stringify({
          available: false,
          date: targetDate,
          day_name: dayNames[dayOfWeek],
          message: `Vi har dessverre ikke åpent på ${dayNames[dayOfWeek]}er. Vi er tilgjengelige på: ${availDays}.`
        });
      }
      
      // 2. Generate all possible time slots from availability
      const allSlots = [];
      for (const avail of availSlots) {
        const startParts = avail.start_time.split(':');
        const endParts = avail.end_time.split(':');
        const startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
        const endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
        const duration = avail.slot_duration || 60;
        
        for (let t = startMin; t + duration <= endMin; t += duration) {
          const hours = Math.floor(t / 60);
          const mins = t % 60;
          const slotStr = `${String(hours).padStart(2,'0')}${String(mins).padStart(2,'0')}`;
          const displayStr = mins === 0 ? `${hours}` : `${hours}.${String(mins).padStart(2,'0')}`;
          allSlots.push({ time: slotStr, display: displayStr, minutes: t });
        }
      }
      
      // 3. Get existing bookings for this date
      const bookings = await db.all(
        `SELECT b.preferred_time, b.duration_minutes, b.service_requested, c.name 
         FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id 
         WHERE b.company_id = $1 AND b.preferred_date = $2::text 
         AND b.status NOT IN ('Avbestilt','Avslått/nei','Lagt på') 
         AND b.cancelled = 0
         ORDER BY b.preferred_time`,
        companyId, targetDate
      );
      
      // 4. Remove booked slots (including duration blocking)
      const bookedMinutes = new Set();
      for (const booking of bookings) {
        if (booking.preferred_time) {
          const timeParts = booking.preferred_time.replace('.', ':').split(':');
          const bookStart = parseInt(timeParts[0]) * 60 + (parseInt(timeParts[1]) || 0);
          const bookDuration = booking.duration_minutes || 60;
          // Block the entire duration
          for (let m = bookStart; m < bookStart + bookDuration; m++) {
            bookedMinutes.add(m);
          }
        }
      }
      
      // Filter out slots where any minute in the slot duration is booked
      const defaultDuration = availSlots[0]?.slot_duration || 60;
      const freeSlots = allSlots.filter(slot => {
        for (let m = slot.minutes; m < slot.minutes + defaultDuration; m++) {
          if (bookedMinutes.has(m)) return false;
        }
        return true;
      });
      
      // 5. Build response
      if (freeSlots.length === 0) {
        // Check next 7 days for availability
        const nextDays = [];
        for (let i = 1; i <= 7; i++) {
          const nextDate = new Date(dateObj);
          nextDate.setDate(nextDate.getDate() + i);
          const nextDow = nextDate.getDay();
          const hasAvail = await db.get(
            `SELECT 1 FROM availability WHERE company_id = $1 AND day_of_week = $2 AND is_active = true LIMIT 1`,
            companyId, nextDow
          );
          if (hasAvail) {
            const nextDateStr = nextDate.toISOString().split('T')[0];
            nextDays.push(`${dayNames[nextDow]} ${nextDate.getDate()}.`);
            if (nextDays.length >= 3) break;
          }
        }
        
        return JSON.stringify({
          available: false,
          date: targetDate,
          day_name: dayNames[dayOfWeek],
          booked_count: bookings.length,
          message: `${dayNames[dayOfWeek]} ${targetDate} er dessverre fullbooket.${nextDays.length ? ` Nærmeste ledige dager: ${nextDays.join(', ')}.` : ''}`
        });
      }
      
      const freeList = freeSlots.map(s => `kl ${s.display}`).join(', ');
      
      return JSON.stringify({
        available: true,
        date: targetDate,
        day_name: dayNames[dayOfWeek],
        free_slots: freeSlots.map(s => s.display),
        free_count: freeSlots.length,
        booked_count: bookings.length,
        message: `${dayNames[dayOfWeek]} ${targetDate} har vi ledig: ${freeList}. Hvilket klokkeslett passer best?`
      });
      
    } catch(e) { 
      console.error('check_availability error:', e);
      return JSON.stringify({ error: e.message }); 
    }
  }

  // ===== GET PRICE ESTIMATE — AI function call =====
  async function handleGetPriceEstimate(companyId, service) {
    try {
      // Look at historical bookings for similar services
      const similar = await db.all(
        `SELECT b.service_requested, b.price, c.name 
         FROM bookings b JOIN customers c ON b.customer_id = c.id 
         WHERE b.company_id = $1 AND b.price IS NOT NULL AND b.price > 0 
         ORDER BY b.created_at DESC LIMIT 10`,
        companyId
      );
      if (!similar.length) return JSON.stringify({ message: 'Ingen prishistorikk tilgjengelig ennå. Be kunden kontakte oss for et pristilbud.' });
      const avg = Math.round(similar.reduce((s,b) => s + b.price, 0) / similar.length);
      const min = Math.min(...similar.map(b => b.price));
      const max = Math.max(...similar.map(b => b.price));
      return JSON.stringify({ average_price: avg, min_price: min, max_price: max, sample_count: similar.length, message: `Basert på ${similar.length} tidligere oppdrag: Gjennomsnitt ${avg} kr (${min}-${max} kr). Dette er veiledende — endelig pris avtales etter befaring.` });
    } catch(e) { return JSON.stringify({ error: e.message }); }
  }

  // ===== VAPI WEBHOOK — mottar events fra Vapi voice assistant =====
  // Alias: begge URL-varianter fungerer
  app.post('/api/vapi/webhook', (req, res, next) => { req.url = '/api/vapi-webhook'; next(); });
  
  app.post('/api/vapi-webhook', async (req, res) => {
    const event = req.body;
    const eventType = event.message?.type || event.type || 'unknown';
    console.log(`📞 Vapi event: ${eventType}`);
    
    // FULL DEBUG — logg HELE payload for å finne transcript/recording
    if (eventType === 'end-of-call-report') {
      console.log('📋 FULL VAPI PAYLOAD:', JSON.stringify(event).substring(0, 5000));
    }

    try {
      // ===== HANDLE FUNCTION CALLS FROM VAPI =====
      if (eventType === 'tool-calls' || event.message?.type === 'tool-calls') {
        const toolCalls = event.message?.toolCalls || event.toolCalls || [];
        const results = [];
        
        for (const toolCall of toolCalls) {
          const fnName = toolCall.function?.name;
          const args = toolCall.function?.arguments ? 
            (typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments) : {};
          
          console.log(`🔧 Function call: ${fnName}`, args);
          
          let result = '';
          try {
            if (fnName === 'validate_address') {
              result = await handleValidateAddress(args);
            } else if (fnName === 'lookup_postal_code') {
              result = await handleLookupPostalCode(args);
            } else if (fnName === 'check_company_services') {
              const companyId = await extractCompanyIdFromCall(event);
              result = await handleCheckServices(companyId, db);
            } else if (fnName === 'check_customer') {
              const companyId = await extractCompanyIdFromCall(event);
              result = await handleCheckCustomer(args.phone, companyId, db);
            } else if (fnName === 'check_availability') {
              const companyId = await extractCompanyIdFromCall(event);
              result = await handleCheckAvailability(companyId, args.date);
            } else if (fnName === 'get_price_estimate') {
              const companyId = await extractCompanyIdFromCall(event);
              result = await handleGetPriceEstimate(companyId, args.service);
            } else {
              result = JSON.stringify({ error: 'Unknown function' });
            }
          } catch (err) {
            console.error(`❌ Function call error (${fnName}):`, err.message);
            result = JSON.stringify({ error: err.message });
          }
          
          results.push({
            toolCallId: toolCall.id,
            result: typeof result === 'string' ? result : JSON.stringify(result)
          });
        }
        
        return res.json({ results });
      }

      // === END OF CALL REPORT — hovedhendelsen ===
      if (eventType === 'end-of-call-report') {
        const report = event.message || event;
        console.log('📋 Report top-level keys:', Object.keys(report));
        console.log('📋 Report.artifact keys:', report.artifact ? Object.keys(report.artifact) : 'NO ARTIFACT');
        console.log('📋 Report.call keys:', report.call ? Object.keys(report.call) : 'NO CALL');
        if (report.call?.artifact) console.log('📋 Report.call.artifact keys:', Object.keys(report.call.artifact));
        
        const customerPhone = report.customer?.number || report.call?.customer?.number || null;
        console.log('📞 Customer phone:', customerPhone);
        
        const transcript = report.transcript || report.artifact?.transcript || report.call?.artifact?.transcript || report.artifact?.messages || '';
        // Recording URL — sjekk ALLE mulige stier i Vapi payload
        const recordingUrl = report.recordingUrl 
          || report.artifact?.recordingUrl 
          || report.artifact?.stereoRecordingUrl
          || report.call?.artifact?.recordingUrl 
          || report.call?.artifact?.stereoRecordingUrl
          || report.artifact?.recording?.url 
          || report.stereoRecordingUrl
          || null;
        console.log('🎙️ Recording URL:', recordingUrl || 'INGEN');
        // Debug: log alle artifact-nøkler for å finne riktig sti
        if (!recordingUrl) {
          console.log('🔍 Report keys:', Object.keys(report));
          if (report.artifact) console.log('🔍 Artifact keys:', Object.keys(report.artifact));
          if (report.call?.artifact) console.log('🔍 Call.artifact keys:', Object.keys(report.call.artifact));
        }
        const summary = report.summary || report.artifact?.summary || '';
        const duration = report.durationSeconds || report.call?.duration || 0;
        const endReason = report.endedReason || 'unknown';

        // Finn selskap via Vapi assistant ID (prioritet 1) eller telefonnummer (prioritet 2)
        const vapiAssistantId = report.assistantId || report.call?.assistantId || report.assistant?.id || null;
        const vapiPhone = report.phoneNumber?.number || report.call?.phoneNumber?.number || null;
        let company = null;
        if (vapiAssistantId) {
          company = await db.get('SELECT * FROM companies WHERE vapi_assistant_id = $1', vapiAssistantId);
        }
        if (!company && vapiPhone) {
          company = await db.get('SELECT * FROM companies WHERE phone = $1 OR phone = $2', vapiPhone, vapiPhone.replace('+1', '+'));
        }
        if (!company) {
          company = await db.get('SELECT * FROM companies WHERE id = 6'); // Fallback til Hundorp (aktiv test)
        }
        console.log(`🏢 Selskap: ${company?.name || 'UKJENT'} (ID: ${company?.id}) via ${vapiAssistantId ? 'assistant ID' : 'telefon'}`);

        // Bygg full transcript-tekst
        let transcriptText = '';
        if (Array.isArray(transcript)) {
          transcriptText = transcript.map(t => `${t.role === 'assistant' ? 'AI' : 'Kunde'}: ${t.message || t.text || ''}`).join('\n');
        } else if (typeof transcript === 'string') {
          transcriptText = transcript;
        }

        // Parse kundeinfo fra transcript via GPT
        let extractedInfo = {};
        let isBooking = false;
        try {
          const { OpenAI } = require('openai');
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const extraction = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `Du er verdens beste dataekstraktor for norske telefonsamtaler med ALLE dialekter + Deepgram STT-feil.

DATO: I dag er ${new Date().toLocaleDateString('no-NO', {weekday:'long',year:'numeric',month:'long',day:'numeric'})} (${new Date().toISOString().split('T')[0]}). Regn ut ALLE relative datoer!
- "neste torsdag/tosdan" = finn neste torsdag. "i morgen" = +1 dag. "på fredag/freda" = kommende fredag. "neste uke" = mandag neste uke.
- Dagnavn: tosdan/torsdan/tossda=torsdag, onsda/onsta=onsdag, tirsdan/tisdan=tirsdag, freda/fredan/frida=fredag, manda/månda=mandag, lauda/lørda=lørdag, sønda=søndag.
- "om to uker" = +14 dager. "i neste uke" = neste mandag. "etter påske" = bruk kalender.
- Returner YYYY-MM-DD.

DIALEKT-TALL:
- ein=1, to=2, tre=3, fire/før/fær=4, fem/fæm=5, seks=6, sju/sjø=7, åtte=8, ni=9, ti=10.
- ølløv/ællæv=11, tålv=12, trættån=13, fjortån=14, fæmtån=15, sekstån=16, søttån=17, åttån=18, nittån=19.
- tjuge/tjue=20, tretti/trøtti=30, førti=40, fømti=50, sækksti=60, søtti=70, åtti=80, nitti=90.
- Sammensatte: tuhundreååtteåfør=248, åttåfør=84, seksåfemti=650, sjunsækksti=76, hundreåseks=106, tuhundreåfemti=250.
- Postnr: "tjueseks førti"=2640, "tjueseks hundre"=2600.

ADRESSE-TOLKNING (ALLER VIKTIGST!):
Deepgram splitter ALLTID sammensatte adresser og legger til FEIL bynavn!
- "ruste Bergen"/"ruste vegen" = Rustevegen (ALDRI Bergen!)
- "ga'lvæga"/"galvegga"/"gard veggen" = Gardvegen
- "kjerring dokka"/"skjerring dokken" = Kjerringdokka
- "nedre gata" = Nedregata. "stor gata" = Storgata. "stasjon svegen" = Stasjonsvegen.
- "bjørke vegen" = Bjørkevegen. "furu vegen" = Furuvegen. "gran vegen" = Granvegen.
- "elve gata" = Elvegata. "kirke gata" = Kirkegata. "sjø gata" = Sjøgata.
- "kvam svegen" = Kvamsvegen. "myr vegen" = Myrvegen. "gammel vegen" = Gamlevegen.
Gatetyper: væga/vægjen/veggen=vegen, gåta/gata=gata, bakka/bakken=bakken, dokka/dokken=dokka, haugen/haugjen=haugen, stien/stia=stien, løkka/lykkja=løkka, grenda=grenda, moen=moen, åsen=åsen, vollen=vollen, kroken=kroken.
REGEL: FJERN feilaktige bynavn!
REGEL: Sammensatte stedsnavn = ETT ord: "kjerring dokka" = "Kjerringdokka"

STEDSNAVN: Vinstra/vinra=Vinstra(2640), Hundorp/hunnorp=Hundorp(2643), Kvam=Kvam(2642), Ringebu=Ringebu(2630), Fåvang=Fåvang(2634), Tretten=Tretten(2635), Lillehammer/hammar=Lillehammer(2600-2619), Otta=Otta(2670), Dombås=Dombås(2660).

NAVN-TOLKNING (KRITISK — ALDRI returner null for navn!):
- Hent ALLTID kundens navn fra transkriptet!
- STT-feil: "franc"=Frank, "tårbjørn"=Torbjørn, "sjønn"=Jon, "eigil"=Eigil, "ola"=Ola, "per"=Per.
- Mønstre: "mitt navn er [X]", "æ heite [X]", "je hete [X]", "de e [X]", "je er [X]" → hent [X]!
- Selv usikre navn → returner det du hører. "Ny innringer" er ALDRI akseptabelt!

DIALEKT-ORD: æ/je=jeg, mæ=meg, dæ=deg, ka/kva=hva, kor=hvor, ikkje/itj=ikke, heime=hjemme, tå=av, nåke=noe, dom=de/dem, ho=hun, berre=bare, au/å=også.

Svar KUN med JSON: {name, address, postal_code, service_requested, preferred_date (YYYY-MM-DD), preferred_time, preferred_employee, befaring (true/false), comment, is_booking (true=minst navn+dato ELLER navn+tjeneste), samtale_avbrutt (true=AI la på for tidlig/samtale brått slutt)}
VIKTIG: name skal ALDRI være null/tom hvis kunden har sagt navnet sitt!` },
              { role: 'user', content: transcriptText || summary || 'Ingen transcript tilgjengelig' }
            ],
            temperature: 0
          });
          const jsonMatch = extraction.choices[0]?.message?.content?.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            extractedInfo = JSON.parse(jsonMatch[0]);
            // Normaliser dato til ISO
            if (extractedInfo.preferred_date) {
              extractedInfo.preferred_date = normalizeDateToISO(extractedInfo.preferred_date);
            }
            isBooking = extractedInfo.is_booking === true;
          }
        } catch (parseErr) {
          console.error('Vapi extraction error:', parseErr.message);
        }

        // Lagre samtale i calls-tabellen
        const callResult = await db.get(
          `INSERT INTO calls (company_id, twilio_call_sid, status, transcript, audio_url, call_duration, call_outcome, extracted_info, source, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Telefon', NOW()) RETURNING id`,
          [
            company?.id || 6,
            report.call?.id || 'vapi-' + Date.now(),
            isBooking ? 'completed' : (endReason === 'customer-ended-call' ? 'hangup' : 'no-booking'),
            transcriptText,
            recordingUrl,
            Math.round(duration),
            endReason,
            JSON.stringify(extractedInfo)
          ]
        );

        const callId = callResult?.id;

        // Opprett eller oppdater kunde i customers-tabellen
        if (extractedInfo.name && extractedInfo.name !== 'null') {
          try {
            // Sjekk om kunden allerede finnes (basert på telefonnummer)
            let existingCust = customerPhone ? await db.get(
              'SELECT * FROM customers WHERE phone = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1',
              [customerPhone, company?.id || 6]
            ) : null;

            const commentParts = [];
            if (extractedInfo.preferred_employee) commentParts.push(`Ønsket ansatt: ${extractedInfo.preferred_employee}`);
            if (extractedInfo.comment) commentParts.push(extractedInfo.comment);
            const fullComment = commentParts.join('. ');

            if (existingCust) {
              // Oppdater eksisterende kunde
              await db.run(
                `UPDATE customers SET name = COALESCE($1, name), address = COALESCE($2, address), postal_code = COALESCE($3, postal_code),
                 service_requested = COALESCE($4, service_requested), preferred_date = COALESCE($5, preferred_date),
                 preferred_time = COALESCE($6, preferred_time), comment = COALESCE($7, comment),
                 status = CASE WHEN $8 THEN 'Ny' ELSE status END, updated_at = NOW()
                 WHERE id = $9`,
                [extractedInfo.name, extractedInfo.address, extractedInfo.postal_code,
                 extractedInfo.service_requested, extractedInfo.preferred_date, extractedInfo.preferred_time,
                 fullComment || null, isBooking, existingCust.id]
              );
              // Link call to customer
              if (callId) await db.run('UPDATE calls SET customer_id = $1 WHERE id = $2', existingCust.id, callId);
            } else {
              // Opprett ny kunde
              const custResult = await db.get(
                `INSERT INTO customers (company_id, name, phone, address, postal_code, service_requested, preferred_date, preferred_time, comment, status, source, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Telefon', NOW()) RETURNING id`,
                [
                  company?.id || 6,
                  extractedInfo.name,
                  customerPhone,
                  extractedInfo.address,
                  extractedInfo.postal_code,
                  extractedInfo.service_requested,
                  extractedInfo.preferred_date,
                  extractedInfo.preferred_time,
                  fullComment || null,
                  isBooking ? 'Ny' : 'Ny'
                ]
              );
              if (callId && custResult?.id) await db.run('UPDATE calls SET customer_id = $1 WHERE id = $2', custResult.id, callId);
            }
          } catch (custErr) {
            console.error('Customer save error:', custErr.message);
          }
        }

        // Send SMS (respekterer toggles)
        if (company) {
          try {
            const smsHandler = require('./sms-handler');

            // ÉN SMS til ansatt — "Ny kunde venter!" med all info fra samtalen
            if (company.sms_extract_employee !== false && (company.montour_phone || company.boss_phone)) {
              const targetPhone = company.montour_phone || company.boss_phone;
              let smsBody;
              if (isBooking) {
                const parts = [`📞 Ny kunde venter! — ${company.name}`];
                if (extractedInfo.name) parts.push(`Navn: ${extractedInfo.name}`);
                parts.push(`Tlf: ${customerPhone || '?'}`);
                if (extractedInfo.service_requested) parts.push(`Tjeneste: ${extractedInfo.service_requested}`);
                if (extractedInfo.address) parts.push(`Adresse: ${extractedInfo.address}${extractedInfo.postal_code ? ' ' + extractedInfo.postal_code : ''}`);
                if (extractedInfo.preferred_date) parts.push(`Dato: ${extractedInfo.preferred_date}`);
                if (extractedInfo.alternative_dates) parts.push(`Alt. datoer: ${extractedInfo.alternative_dates}`);
                if (extractedInfo.preferred_time) parts.push(`Tid: ${extractedInfo.preferred_time}`);
                if (extractedInfo.preferred_employee) parts.push(`Ønsket ansatt: ${extractedInfo.preferred_employee}`);
                if (extractedInfo.comment) parts.push(`Kommentar: ${extractedInfo.comment}`);
                smsBody = parts.join('\n');
              } else {
                smsBody = `📞 Ny innringer — ${company.name}\n\nIngen bestilling\nTlf: ${customerPhone || 'Ukjent'}\nVarighet: ${Math.round(duration)}s\nSammendrag: ${summary || transcriptText?.substring(0, 200) || 'Kort samtale'}`;
              }
              try {
                const twilio = require('twilio')(process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN, { accountSid: process.env.TWILIO_ACCOUNT_SID });
                await twilio.messages.create({
                  body: smsBody,
                  from: process.env.TWILIO_PHONE_NUMBER || '+12602612731',
                  to: targetPhone
                });
                console.log('✅ Ansatt-SMS sendt til', targetPhone);
              } catch (smsErr) { console.error('Ansatt-SMS feil:', smsErr.message); }
            }
            // INGEN automatisk bekreftelse-SMS til kunde her — sendes KUN ved manuelt klikk i CRM
          } catch (smsErr) { console.error('SMS cascade error:', smsErr.message); }
        }

        // Kjør auto-analyse
        try {
          const analyzer = require('./call-analyzer');
          if (callId && transcriptText) {
            await analyzer.analyzeCall(callId, transcriptText, company?.id || 6);
          }
        } catch (analyzeErr) { console.error('Vapi analysis error:', analyzeErr.message); }

        // Auto-læring
        try {
          const autoLearner = require('./auto-learner');
          if (callId) {
            await autoLearner.autoImproveFromCall(callId);
          }
        } catch (learnErr) { console.error('Vapi auto-learn error:', learnErr.message); }

        console.log(`✅ Vapi call processed: ${callId} | ${company?.name} | booking: ${isBooking} | duration: ${Math.round(duration)}s`);
        return res.json({ ok: true, callId, companyId: company?.id });
      }

      // === STATUS UPDATE ===
      if (eventType === 'status-update') {
        const status = event.message?.status || event.status;
        console.log(`📊 Vapi status: ${status}`);
        return res.json({ ok: true });
      }

      // === ASSISTANT REQUEST — dynamisk assistent-konfigurasjon ===
      if (eventType === 'assistant-request') {
        return res.json({ ok: true });
      }

      // === TRANSCRIPT UPDATE ===
      if (eventType === 'transcript') {
        return res.json({ ok: true });
      }

      // Default
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Vapi webhook error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Selskapsoppsett — koble bedriftsnummer til Vapi-assistent =====
  // POST /api/company/:id/connect-phone { phone_number: "+47..." }
  // Oppretter Vapi-assistent med selskapets system_prompt og kobler nummeret
  app.post('/api/company/:id/connect-phone', async (req, res) => {
    try {
      const companyId = parseInt(req.params.id);
      const { phone_number } = req.body;
      if (!phone_number) return res.status(400).json({ error: 'phone_number er påkrevd' });

      const company = await db.get('SELECT * FROM companies WHERE id = $1', companyId);
      if (!company) return res.status(404).json({ error: 'Selskap ikke funnet' });

      // Check if phone feature is enabled for this company (v3.9.53)
      if (company.feature_phone === false) {
        return res.status(403).json({ error: 'Telefon AI er deaktivert for dette selskapet. Aktiver modulen i innstillinger.' });
      }

      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY ikke satt i miljøvariabler' });

      const basePrompt = buildVapiBasePrompt(company);

      const fullPrompt = company.system_prompt
        ? basePrompt + '\nBEDRIFTSSPESIFIKK INFO:\n' + company.system_prompt
        : basePrompt;

      const firstMsg = `God dag, du snakker nå med ${company.name} sin K.I.-assistent. Det vil bli gjort opptak av samtalen for utviklingsformål. Hva kan jeg hjelpe deg med i dag?`;

      // 1. Opprett Vapi-assistent
      const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
      const assistantRes = await fetch('https://api.vapi.ai/assistant', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + VAPI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: company.name + ' KI-Assistent',
          model: {
            provider: 'openai',
            model: 'gpt-realtime-2025-08-28',
            messages: [{ role: 'system', content: fullPrompt }],
            maxTokens: 500,
            temperature: 0.7,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'validate_address',
                  description: 'Validates a Norwegian address using Kartverket API. Call this when the customer gives their address and postal code to verify it is correct. Returns the validated address with correct postal place name.',
                  parameters: {
                    type: 'object',
                    properties: {
                      street: { type: 'string', description: 'Street name and number, e.g. "Kjerringdokka 13a"' },
                      postal_code: { type: 'string', description: '4-digit Norwegian postal code, e.g. "2640"' }
                    },
                    required: ['postal_code']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'lookup_postal_code',
                  description: 'Looks up the place name for a Norwegian postal code. Call this when you need to confirm which city/town a postal code belongs to. GPT already knows most Norwegian postal codes — only call this if unsure.',
                  parameters: {
                    type: 'object',
                    properties: {
                      postal_code: { type: 'string', description: '4-digit Norwegian postal code' }
                    },
                    required: ['postal_code']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'check_company_services',
                  description: 'Returns the list of services this company offers. Call this when the customer asks "hva kan dere tilby?" or similar questions about available services.',
                  parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'check_customer',
                  description: 'Sjekker om innringeren er en eksisterende kunde. Kall denne stille i bakgrunnen — ALDRI fortell kunden at du sjekker.',
                  parameters: {
                    type: 'object',
                    properties: {
                      phone: { type: 'string', description: 'The caller phone number in E.164 format' }
                    },
                    required: ['phone']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'check_availability',
                  description: 'Sjekker om en dato/tid er ledig for booking. Kall denne når kunden foreslår en dato.',
                  parameters: {
                    type: 'object',
                    properties: {
                      date: { type: 'string', description: 'Dato i YYYY-MM-DD format' }
                    },
                    required: ['date']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'get_price_estimate',
                  description: 'Henter prisinformasjon basert på historikk. Kall denne når kunden spør om pris.',
                  parameters: {
                    type: 'object',
                    properties: {
                      service: { type: 'string', description: 'Tjenesten kunden spør om' }
                    },
                    required: ['service']
                  }
                }
              },
              {
                type: 'transferCall',
                destinations: [{
                  type: 'number',
                  number: company.montour_phone || company.boss_phone || '+4797479157',
                  message: 'Jeg kobler deg nå til en kollega. Vennligst vent et øyeblikk.',
                  transferPlan: {
                    mode: 'warm-transfer-with-summary',
                    summaryPlan: {
                      enabled: true,
                      messages: [
                        { role: 'system', content: 'Gi en kort oppsummering på norsk av hva kunden trenger.' },
                        { role: 'user', content: 'Her er transkripsjonen:\n\n{{transcript}}\n\n' }
                      ]
                    }
                  }
                }],
                function: {
                  name: 'transferCall',
                  description: 'Overfør til kollega. BARE når kunden EKSPLISITT ber om det. ALDRI transfer fordi du ikke forstår — spør heller på nytt.',
                  parameters: {
                    type: 'object',
                    properties: {
                      destination: { type: 'string', description: 'The phone number to transfer to' }
                    },
                    required: ['destination']
                  }
                }
              }
            ]
          },
          voice: { provider: 'openai', voiceId: 'marin' },
          firstMessage: firstMsg,
          serverUrl: 'https://backend-production-6779.up.railway.app/api/vapi-webhook',
          recordingEnabled: true,
          artifactPlan: {
            recordingEnabled: true,
            videoRecordingEnabled: false
          },
          endCallFunctionEnabled: true,
          backgroundSound: 'off',
          backgroundDenoisingEnabled: true,
          silenceTimeoutSeconds: 45,
          maxDurationSeconds: 900
        })
      });
      const assistant = await assistantRes.json();
      if (!assistant.id) return res.status(500).json({ error: 'Vapi-assistent feilet', details: assistant });

      // 2. Importer telefonnummer til Vapi og koble til assistent
      const phoneRes = await fetch('https://api.vapi.ai/phone-number', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + VAPI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'twilio',
          number: phone_number,
          twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
          twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
          assistantId: assistant.id
        })
      });
      const phoneResult = await phoneRes.json();

      // 3. Oppdater DB med Vapi-assistent-ID og telefonnummer
      await db.run('UPDATE companies SET vapi_assistant_id = $1, phone = $2 WHERE id = $3', assistant.id, phone_number, companyId);

      console.log(`🔗 ${company.name} koblet til ${phone_number} via Vapi (${assistant.id})`);
      res.json({
        ok: true,
        company: company.name,
        assistantId: assistant.id,
        assistantName: assistant.name,
        phone: phone_number,
        phoneImport: phoneResult.id ? 'OK' : phoneResult
      });
    } catch (err) {
      console.error('Company connect-phone error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/company/:id/sync-vapi — synkroniser system_prompt til Vapi-assistent
  app.post('/api/company/:id/sync-vapi', async (req, res) => {
    try {
      const companyId = parseInt(req.params.id);
      const company = await db.get('SELECT * FROM companies WHERE id = $1', companyId);
      if (!company) return res.status(404).json({ error: 'Selskap ikke funnet' });
      if (!company.system_prompt) return res.status(400).json({ error: 'Selskapet har ingen system_prompt' });

      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler i env' });

      // Build the full AI prompt using shared base prompt + company-specific info
      const greeting = `God dag, du snakker nå med ${company.name.replace('AS', '').trim()} sin K.I.-assistent. Det vil bli gjort opptak av samtalen for utviklingsformål. Hva kan jeg hjelpe deg med i dag?`;
      
      const basePrompt = buildVapiBasePrompt(company);
      const fullPrompt = basePrompt + '\nBEDRIFTSSPESIFIKK INFO:\n' + company.system_prompt;

      // Auto-create Vapi assistant if none exists
      let assistantId = company.vapi_assistant_id;
      let wasCreated = false;
      if (!assistantId) {
        console.log(`🆕 Oppretter ny Vapi-assistent for ${company.name}...`);
        const createResp = await fetch('https://api.vapi.ai/assistant', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: (company.name + ' KI-Assistent').substring(0, 40) })
        });
        const createData = await createResp.json();
        if (!createResp.ok) return res.status(500).json({ error: 'Kunne ikke opprette Vapi-assistent', details: createData });
        assistantId = createData.id;
        await db.run('UPDATE companies SET vapi_assistant_id = $1 WHERE id = $2', assistantId, companyId);
        console.log(`✅ Vapi-assistent opprettet: ${assistantId} for ${company.name}`);
        wasCreated = true;
      }

      const vapiResp = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: {
            provider: 'openai',
            model: 'gpt-realtime-2025-08-28',
            messages: [{ role: 'system', content: fullPrompt }],
            maxTokens: 500,
            temperature: 0.7,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'validate_address',
                  description: 'Validates a Norwegian address using Kartverket API. Call this when the customer gives their address and postal code to verify it is correct. Returns the validated address with correct postal place name.',
                  parameters: {
                    type: 'object',
                    properties: {
                      street: { type: 'string', description: 'Street name and number, e.g. "Kjerringdokka 13a"' },
                      postal_code: { type: 'string', description: '4-digit Norwegian postal code, e.g. "2640"' }
                    },
                    required: ['postal_code']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'lookup_postal_code',
                  description: 'Looks up the place name for a Norwegian postal code. Call this when you need to confirm which city/town a postal code belongs to. GPT already knows most Norwegian postal codes — only call this if unsure.',
                  parameters: {
                    type: 'object',
                    properties: {
                      postal_code: { type: 'string', description: '4-digit Norwegian postal code' }
                    },
                    required: ['postal_code']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'check_company_services',
                  description: 'Returns the list of services this company offers. Call this when the customer asks "hva kan dere tilby?" or similar questions about available services.',
                  parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'check_customer',
                  description: 'Sjekker om innringeren er en eksisterende kunde. Kall denne stille i bakgrunnen — ALDRI fortell kunden at du sjekker.',
                  parameters: {
                    type: 'object',
                    properties: {
                      phone: { type: 'string', description: 'Caller phone number in E.164 format' }
                    },
                    required: ['phone']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'check_availability',
                  description: 'Sjekker om en dato er ledig for booking. Kall denne når kunden foreslår en dato. Returnerer opptatte tider og ukebelastning.',
                  parameters: {
                    type: 'object',
                    properties: {
                      date: { type: 'string', description: 'Dato i YYYY-MM-DD format' }
                    },
                    required: ['date']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'get_price_estimate',
                  description: 'Henter prisoverslag basert på historikk. Kall denne når kunden spør om pris.',
                  parameters: {
                    type: 'object',
                    properties: {
                      service: { type: 'string', description: 'Tjenesten kunden spør om' }
                    },
                    required: ['service']
                  }
                }
              },
              {
                type: 'transferCall',
                destinations: [{
                  type: 'number',
                  number: company.montour_phone || company.boss_phone || '+4797479157',
                  message: 'Jeg kobler deg nå til en kollega. Vennligst vent et øyeblikk.',
                  transferPlan: {
                    mode: 'warm-transfer-with-summary',
                    summaryPlan: {
                      enabled: true,
                      messages: [
                        { role: 'system', content: 'Gi en kort oppsummering på norsk av hva kunden trenger.' },
                        { role: 'user', content: 'Her er transkripsjonen:\n\n{{transcript}}\n\n' }
                      ]
                    }
                  }
                }],
                function: {
                  name: 'transferCall',
                  description: 'Overfør til kollega. BARE når kunden EKSPLISITT ber om det. ALDRI transfer fordi du ikke forstår — spør heller på nytt.',
                  parameters: {
                    type: 'object',
                    properties: {
                      destination: { type: 'string', description: 'The phone number to transfer to' }
                    },
                    required: ['destination']
                  }
                }
              }
            ]
          },
          transcriber: null,
          voice: { provider: 'openai', voiceId: 'marin' },
          recordingEnabled: true,
          artifactPlan: {
            recordingEnabled: true,
            videoRecordingEnabled: false
          },
          backgroundSound: 'off',
          backgroundDenoisingEnabled: true,
          silenceTimeoutSeconds: 45,
          maxDurationSeconds: 900,
          firstMessage: greeting,
          serverUrl: 'https://backend-production-6779.up.railway.app/api/vapi/webhook'
        })
      });

      const vapiData = await vapiResp.json();
      if (!vapiResp.ok) return res.status(500).json({ error: 'Vapi feil', details: vapiData });

      console.log(`✅ ${wasCreated ? 'Opprettet og synkroniserte' : 'Synkroniserte'} Vapi-assistent for ${company.name} (${assistantId})`);
      res.json({ success: true, company: company.name, assistantId: assistantId, wasCreated, promptLength: fullPrompt.length, vapiModel: vapiData.model?.model, vapiVoice: vapiData.voice?.voiceId, vapiTranscriber: vapiData.transcriber || 'none (realtime)', recordingEnabled: vapiData.artifactPlan?.recordingEnabled });
    } catch (err) {
      console.error('Sync-vapi error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/company/:id/vapi-config — les hva Vapi faktisk har konfigurert
  app.get('/api/company/:id/vapi-config', async (req, res) => {
    try {
      const company = await db.get('SELECT * FROM companies WHERE id = $1', parseInt(req.params.id));
      if (!company || !company.vapi_assistant_id) return res.status(404).json({ error: 'Ingen Vapi-assistent' });
      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler' });
      const vapiResp = await fetch(`https://api.vapi.ai/assistant/${company.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
      });
      const data = await vapiResp.json();
      res.json({
        company: company.name,
        assistantId: company.vapi_assistant_id,
        model: data.model ? { provider: data.model.provider, model: data.model.model } : 'NOT SET',
        voice: data.voice ? { provider: data.voice.provider, voiceId: data.voice.voiceId } : 'NOT SET',
        transcriber: data.transcriber || 'none (realtime = no separate transcriber)',
        recordingEnabled: data.recordingEnabled,
        artifactPlan: data.artifactPlan || null,
        silenceTimeoutSeconds: data.silenceTimeoutSeconds,
        maxDurationSeconds: data.maxDurationSeconds,
        firstMessage: data.firstMessage?.substring(0, 100) + '...',
        serverUrl: data.serverUrl
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/debug/vapi-calls — se siste Vapi-samtaler direkte
  app.get('/api/debug/vapi-calls', async (req, res) => {
    try {
      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler' });
      const vapiResp = await fetch(`https://api.vapi.ai/call?limit=${req.query.limit || 5}`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
      });
      const calls = await vapiResp.json();
      if (!Array.isArray(calls)) return res.json({ error: 'Unexpected response', raw: calls });
      
      const summary = calls.map(c => ({
        id: c.id,
        status: c.status,
        assistantId: c.assistantId,
        callerPhone: c.customer?.number || 'ukjent',
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        duration: c.startedAt && c.endedAt ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000) + 's' : '?',
        recordingUrl: c.recordingUrl || c.artifact?.recordingUrl || c.artifact?.stereoRecordingUrl || null,
        hasTranscript: Array.isArray(c.transcript) ? c.transcript.length + ' messages' : typeof c.transcript === 'string' ? c.transcript.length + ' chars' : 'none',
        artifactMessages: c.artifact?.messages?.length || 0,
        artifactTranscriptChars: c.artifact?.messages?.filter(m => m.role === 'assistant' || m.role === 'user').map(m => m.message || m.content || '').join('').length || 0,
        topKeys: Object.keys(c),
        artifactKeys: c.artifact ? Object.keys(c.artifact) : 'no artifact'
      }));
      res.json({ count: calls.length, calls: summary });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/debug/vapi-phones — list all Vapi phone numbers and their assistant assignments
  app.get('/api/debug/vapi-phones', async (req, res) => {
    try {
      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler' });
      const phoneRes = await fetch('https://api.vapi.ai/phone-number', {
        headers: { 'Authorization': 'Bearer ' + VAPI_KEY }
      });
      const phones = await phoneRes.json();
      res.json(phones);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/debug/run-recovery — trigger recovery manuelt med verbose output
  // Supports ?process=true to actually process calls inline with full error reporting
  app.post('/api/debug/run-recovery', async (req, res) => {
    try {
      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler' });
      
      const vapiResp = await fetch('https://api.vapi.ai/call?limit=20', {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
      });
      if (!vapiResp.ok) return res.status(500).json({ error: 'Vapi API feil', status: vapiResp.status });
      const vapiCalls = await vapiResp.json();
      
      const doProcess = req.query.process === 'true';
      const results = [];
      
      for (const vc of vapiCalls) {
        const item = { id: vc.id, status: vc.status, caller: vc.customer?.number };
        if (vc.status !== 'ended') { item.skip = 'not ended'; results.push(item); continue; }
        
        const existing = await db.query('SELECT id FROM calls WHERE twilio_call_sid = $1', [`vapi_${vc.id}`]);
        if (existing.rows.length > 0) { item.skip = 'already saved'; results.push(item); continue; }
        
        const comp = await db.query('SELECT id, name, requires_worker_approval FROM companies WHERE vapi_assistant_id = $1', [vc.assistantId]);
        if (comp.rows.length === 0) { item.skip = 'no matching company for assistant ' + vc.assistantId; results.push(item); continue; }
        
        item.company = comp.rows[0].name;
        item.companyId = comp.rows[0].id;
        item.recordingUrl = vc.recordingUrl || vc.artifact?.recordingUrl || vc.artifact?.stereoRecordingUrl || 'NONE';
        item.transcriptType = typeof vc.transcript;
        item.transcriptLength = typeof vc.transcript === 'string' ? vc.transcript.length : (Array.isArray(vc.transcript) ? vc.transcript.length + ' items' : 'none');
        
        if (doProcess) {
          try {
            // Process this call inline — exact same logic as auto-recovery
            const companyId = comp.rows[0].id;
            const duration = vc.startedAt && vc.endedAt 
              ? Math.round((new Date(vc.endedAt) - new Date(vc.startedAt)) / 1000) : 0;
            // Transcript: sjekk BÅDE vc.transcript OG vc.artifact.messages (OpenAI Realtime)
            const rawTranscript = vc.transcript || '';
            const artifactMessages = vc.artifact?.messages || [];
            const callerPhone = vc.customer?.number || 'ukjent';
            
            let transcriptText = '';
            if (Array.isArray(rawTranscript) && rawTranscript.length > 0) {
              transcriptText = rawTranscript.map(t => `${t.role === 'assistant' ? 'AI' : 'Kunde'}: ${t.message || t.text || ''}`).join('\n');
            } else if (typeof rawTranscript === 'string' && rawTranscript.length > 0) {
              transcriptText = rawTranscript;
            }
            // Fallback: OpenAI Realtime lagrer transcript i artifact.messages
            if (!transcriptText && artifactMessages.length > 0) {
              transcriptText = artifactMessages
                .filter(m => m.role === 'assistant' || m.role === 'user')
                .map(m => `${m.role === 'assistant' ? 'AI' : 'Kunde'}: ${m.message || m.content || m.text || ''}`)
                .join('\n');
            }
            item.transcriptTextLength = transcriptText.length;
            item.transcriptSource = transcriptText ? (artifactMessages.length > 0 && (!rawTranscript || rawTranscript.length === 0) ? 'artifact.messages' : 'transcript') : 'EMPTY';
            
            let outcome = 'hangup';
            if (duration < 10) outcome = 'hangup';
            else if (duration >= 10 && transcriptText.length < 100) outcome = 'hangup';
            
            const recordingUrl = vc.recordingUrl || vc.artifact?.recordingUrl || vc.artifact?.stereoRecordingUrl || null;
            
            // GPT extraction
            let extractedInfo = {};
            let isBooking = false;
            if (transcriptText && transcriptText.length > 50) {
              try {
                const { OpenAI } = require('openai');
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const extraction = await openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                    { role: 'system', content: `Ekstraher kundeinfo fra norsk telefonsamtale. Svar KUN med JSON: {name, address, postal_code, service_requested, preferred_date, preferred_time, preferred_employee, befaring, comment, is_booking, samtale_avbrutt}. Dato: i dag er ${new Date().toISOString().split('T')[0]}.` },
                    { role: 'user', content: transcriptText }
                  ],
                  temperature: 0
                });
                const jsonMatch = extraction.choices[0]?.message?.content?.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  extractedInfo = JSON.parse(jsonMatch[0]);
                  // Normaliser dato til ISO
                  if (extractedInfo.preferred_date) {
                    extractedInfo.preferred_date = normalizeDateToISO(extractedInfo.preferred_date);
                  }
                  isBooking = extractedInfo.is_booking === true;
                }
                item.extractedInfo = extractedInfo;
              } catch (gptErr) { item.gptError = gptErr.message; }
            }
            
            if (isBooking && extractedInfo.name) outcome = 'booking';
            else if (transcriptText.length > 100 && !extractedInfo.name) outcome = 'avbrutt';
            else if (transcriptText.length > 100) outcome = 'no_booking';
            
            // Save customer
            let customerId = null;
            const customerName = extractedInfo.name || extractNameFromTranscript(transcriptText) || 'Ny innringer';
            if (callerPhone !== 'ukjent') {
              const existingCust = await db.query(
                'SELECT id FROM customers WHERE phone = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1',
                [callerPhone, companyId]
              );
              if (existingCust.rows.length > 0) {
                customerId = existingCust.rows[0].id;
                // Smart update
                const badNames = ['ny innringer','user','ukjent','unknown','test'];
                const isGoodName = customerName && !badNames.includes(customerName.toLowerCase()) && customerName.length >= 2;
                if (isGoodName) {
                  await db.query(`UPDATE customers SET name = CASE WHEN name IN ('Ny innringer','User','user','Ukjent','unknown') THEN $1::text ELSE name END, service_requested = COALESCE(NULLIF($2::text,''), service_requested), preferred_date = COALESCE(NULLIF($3::text,''), preferred_date), address = CASE WHEN $4::text IS NOT NULL AND LENGTH($4::text) > 2 AND (address IS NULL OR address = '') THEN $4::text ELSE address END, updated_at = NOW() WHERE id = $5`,
                    [customerName, extractedInfo.service_requested || null, extractedInfo.preferred_date || null, extractedInfo.address || null, customerId]);
                }
                item.customerAction = 'updated existing ' + customerId;
              } else {
                const custResult = await db.query(
                  `INSERT INTO customers (company_id, name, phone, address, postal_code, service_requested, preferred_date, preferred_time, comment, status, source, confirmation_status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Ny','Telefon','pending',$10) RETURNING id`,
                  [companyId, customerName, callerPhone, extractedInfo.address, extractedInfo.postal_code, extractedInfo.service_requested, extractedInfo.preferred_date, extractedInfo.preferred_time, extractedInfo.comment, vc.startedAt]
                );
                customerId = custResult.rows[0].id;
                item.customerAction = 'created new ' + customerId;
              }
            }
            
            // Save call
            await db.query(
              `INSERT INTO calls (customer_id, company_id, twilio_call_sid, duration_seconds, transcript, audio_url, status, call_outcome, call_duration, extracted_info, created_at) VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$4,$8,$9)`,
              [customerId, companyId, `vapi_${vc.id}`, duration, transcriptText, recordingUrl, outcome, JSON.stringify(extractedInfo), vc.startedAt]
            );
            
            // Send SMS
            const fullCompany = (await db.query('SELECT * FROM companies WHERE id = $1', [companyId])).rows[0];
            if (fullCompany?.sms_extract_employee !== false && (fullCompany.montour_phone || fullCompany.boss_phone)) {
              const targetPhone = fullCompany.montour_phone || fullCompany.boss_phone;
              const parts = [`📞 Ny kunde — ${fullCompany.name}`];
              if (extractedInfo.name) parts.push(`Navn: ${extractedInfo.name}`);
              parts.push(`Tlf: ${callerPhone}`);
              if (extractedInfo.service_requested) parts.push(`Tjeneste: ${extractedInfo.service_requested}`);
              if (extractedInfo.address) parts.push(`Adresse: ${extractedInfo.address}${extractedInfo.postal_code ? ' ' + extractedInfo.postal_code : ''}`);
              if (extractedInfo.preferred_date) parts.push(`Dato: ${extractedInfo.preferred_date}`);
              if (extractedInfo.preferred_time) parts.push(`Tid: ${extractedInfo.preferred_time}`);
              try {
                const twilio = require('twilio')(process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN, { accountSid: process.env.TWILIO_ACCOUNT_SID });
                await twilio.messages.create({ body: parts.join('\n'), from: process.env.TWILIO_PHONE_NUMBER || '+12602612731', to: targetPhone });
                item.smsSent = targetPhone;
              } catch (smsErr) { item.smsError = smsErr.message; }
            }
            
            item.processed = true;
            item.outcome = outcome;
            item.duration = duration + 's';
          } catch (processErr) {
            item.processError = processErr.message;
            item.processStack = processErr.stack?.split('\n').slice(0,3).join(' | ');
          }
        } else {
          item.action = 'WILL BE PROCESSED — add ?process=true to process now';
        }
        results.push(item);
      }
      
      res.json({ totalVapiCalls: vapiCalls.length, processed: doProcess, results });
    } catch (err) { res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,3) }); }
  });

  // POST /api/company/:id/switch-phone — bytt eksisterende nummer til annen assistent
  app.post('/api/company/:id/switch-phone', async (req, res) => {
    try {
      const companyId = parseInt(req.params.id);
      const { vapi_phone_id } = req.body;
      if (!vapi_phone_id) return res.status(400).json({ error: 'vapi_phone_id er påkrevd' });

      const company = await db.get('SELECT * FROM companies WHERE id = $1', companyId);
      if (!company || !company.vapi_assistant_id) return res.status(404).json({ error: 'Selskap ikke funnet eller mangler Vapi-assistent' });

      // Check if phone feature is enabled for this company (v3.9.53)
      if (company.feature_phone === false) {
        return res.status(403).json({ error: 'Telefon AI er deaktivert for dette selskapet. Aktiver modulen i innstillinger.' });
      }

      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
      const switchRes = await fetch('https://api.vapi.ai/phone-number/' + vapi_phone_id, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + VAPI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantId: company.vapi_assistant_id })
      });
      const result = await switchRes.json();
      res.json({ ok: true, phone: result.number, assistantId: company.vapi_assistant_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Capacity Calculation Endpoint (v3.9.53) =====
  app.get('/api/capacity', async (req, res) => {
    try {
      const companyCount = await db.get('SELECT COUNT(*) as count FROM companies');
      const totalCalls = await db.get('SELECT COUNT(*) as count FROM calls');
      const totalBookings = await db.get('SELECT COUNT(*) as count FROM bookings');
      const totalSms = await db.get("SELECT COUNT(*) as count FROM messages WHERE direction = $1", 'outbound');
      const totalCustomers = await db.get('SELECT COUNT(*) as count FROM customers');
      
      const callsToday = await db.get("SELECT COUNT(*) as count FROM calls WHERE created_at >= CURRENT_DATE");
      const smsToday = await db.get("SELECT COUNT(*) as count FROM messages WHERE sent_at >= CURRENT_DATE");
      
      const avgDuration = await db.get("SELECT COALESCE(AVG(call_duration), 0) as avg_dur FROM calls WHERE call_duration > 0");
      
      const avgCallDurationMin = ((avgDuration && avgDuration.avg_dur) || 180) / 60;
      const costPerCall = {
        vapi: avgCallDurationMin * 0.05,
        openai_realtime: avgCallDurationMin * 0.06,
        twilio: avgCallDurationMin * 0.02,
        total_call: 0,
        sms_sveve: 0.39,
        sms_twilio: 0.85,
      };
      costPerCall.total_call = costPerCall.vapi + costPerCall.openai_realtime + costPerCall.twilio;
      const costPerCallNOK = costPerCall.total_call * 10.5;
      const costPerSmsNOK = 0.39;
      const totalCostPerBooking = costPerCallNOK + (costPerSmsNOK * 3);
      
      const capacity = {
        current: {
          companies: parseInt(companyCount?.count || 0),
          total_calls: parseInt(totalCalls?.count || 0),
          total_bookings: parseInt(totalBookings?.count || 0),
          total_sms: parseInt(totalSms?.count || 0),
          total_customers: parseInt(totalCustomers?.count || 0),
          calls_today: parseInt(callsToday?.count || 0),
          sms_today: parseInt(smsToday?.count || 0),
          avg_call_duration_sec: Math.round((avgDuration && avgDuration.avg_dur) || 0),
        },
        costs: {
          per_call_usd: Math.round(costPerCall.total_call * 100) / 100,
          per_call_nok: Math.round(costPerCallNOK * 100) / 100,
          per_sms_nok: costPerSmsNOK,
          per_booking_total_nok: Math.round(totalCostPerBooking * 100) / 100,
          monthly_fixed_nok: 63,
        },
        limits: {
          sms_per_day: 50,
          sms_per_month: 1500,
          concurrent_calls: 1,
          calls_per_day_estimate: 200,
          openai_monthly_budget_usd: 50,
          google_maps_free_calls: 10000,
        },
        scaling: {
          note: 'Norske Twilio-numre (~$3/mnd/stk) anbefalt ved 10+ selskaper. SIP-trunk ved 50+.',
          breakeven_per_company_nok: Math.round(totalCostPerBooking * 30),
        }
      };
      
      res.json(capacity);
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Audio Proxy — serves Twilio recordings without requiring Twilio auth =====
  // ===== Admin: Aktiver recording på alle Vapi-assistenter =====
  app.post('/api/admin/enable-recording', async (req, res) => {
    try {
      const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
      if (!VAPI_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY mangler' });
      const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
      const companies = await db.all('SELECT id, name, vapi_assistant_id FROM companies WHERE vapi_assistant_id IS NOT NULL');
      const results = [];
      for (const c of companies) {
        try {
          const patchRes = await fetch('https://api.vapi.ai/assistant/' + c.vapi_assistant_id, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + VAPI_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordingEnabled: true })
          });
          const result = await patchRes.json();
          results.push({ company: c.name, ok: !!result.id, recordingEnabled: result.recordingEnabled });
        } catch (e) { results.push({ company: c.name, error: e.message }); }
      }
      res.json({ ok: true, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/audio/:callId', async (req, res) => {
    try {
      const call = await db.get('SELECT audio_url FROM calls WHERE id = $1', req.params.callId);
      if (!call || !call.audio_url) return res.status(404).json({ error: 'Ingen lydopptak funnet' });
      
      const audioUrl = call.audio_url;
      
      // Vapi recordings: direkte URL (ingen auth nødvendig)
      // Twilio recordings: krever Twilio auth
      const isTwilio = audioUrl.includes('twilio.com') || audioUrl.includes('api.twilio.com');
      const headers = {};
      if (isTwilio) {
        const finalUrl = audioUrl.endsWith('.mp3') ? audioUrl : audioUrl + '.mp3';
        headers['Authorization'] = 'Basic ' + Buffer.from(
          process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
        ).toString('base64');
        var fetchUrl = finalUrl;
      } else {
        var fetchUrl = audioUrl; // Vapi URL — direkte tilgang
      }
      
      const response = await fetch(fetchUrl, { headers });
      if (!response.ok) return res.status(502).json({ error: 'Kunne ikke hente lyd' });
      
      res.set({
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Accept-Ranges': 'bytes'
      });
      
      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error('Audio proxy error:', err.message);
      res.status(500).json({ error: 'Feil ved lasting av lyd' });
    }
  });

  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║   🤖 Coe AI Voice Assistant v2.0       ║
  ║   Server running on port ${PORT}            ║
  ║                                          ║
  ║   Webhooks:                              ║
  ║   POST /twilio/voice    - Incoming calls ║
  ║   POST /twilio/sms      - Incoming SMS   ║
  ║   POST /twilio/recording - Recordings    ║
  ║   POST /twilio/call-status - Hangups     ║
  ║                                          ║
  ║   API:                                   ║
  ║   GET  /api/customers   - List customers ║
  ║   GET  /api/customers/search - Search    ║
  ║   GET  /api/bookings    - Calendar       ║
  ║   GET  /api/stats       - Stats          ║
  ║   GET  /api/stats/revenue - Revenue      ║
  ║   GET  /health          - Health check   ║
  ╚══════════════════════════════════════════╝
    `);
  });
})();

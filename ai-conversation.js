// ===== AI CONVERSATION ENGINE =====
// Handles AI logic for customer calls using OpenAI

const OpenAI = require('openai');
let autoLearner = null;
try { autoLearner = require('./auto-learner'); } catch(e) { console.log('Auto-learner not available'); }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Industry prompt snippets (49 industries) =====
const INDUSTRY_PROMPTS = {
  'generell': 'GENERELL: Generell bedrift. Spør om behov, tidspunkt og kontaktinfo.',
  'frisor': 'FRISØR: Tilbyr: klipp, farge, striping, permanent, extensions, styling, barberering. Spør behandlingstype, hårlengde.',
  'elektriker': 'ELEKTRIKER: Tilbyr: el-installasjon, sikringsskap, belysning, stikk, varmekabler, elbil-lader, feilsøking. Spør type jobb, omfang.',
  'maler': 'MALER: Tilbyr: innvendig/utvendig maling, tapetsering, sparkling, fasade. Spør inn/ut, antall rom, tilstand.',
  'antikviteter': 'ANTIKVITETER: Tilbyr: vurdering, kjøp, salg, restaurering. Spør type gjenstand, formål. Tilstand KUN ved salg. Kunden kan si "annet" og beskrive.',
  'gulv': 'GULV: Tilbyr: parkett, laminat, vinyl, fliser, belegg, sliping, lakkering. Spør type gulv, romstørrelse, underlag.',
  'klesvask': 'KLESVASK: Tilbyr: vask, stryking, reparasjon av klær/tekstiler, sengetøy, gardiner. Spør type plagg, mengde.',
  'vaskebyra': 'VASKEBYRÅ: Tilbyr: husvask, kontorrenhold, flyttevask, vindusvask, byggerenhold, fast avtale. Spør type vask, areal, frekvens.',
  'kosmetikk': 'KOSMETIKK: Tilbyr: sminke, makeup, hudpleieprodukter, parfyme, konsultasjon. Spør produkttype, hudtype.',
  'rorlegging': 'RØRLEGGING: Tilbyr: rørleggerarbeid, bad, kjøkken, vannlekkasje, avløp, varme. Spør type jobb, hastegrad.',
  'spa': 'SPA: Tilbyr: massasje, ansiktsbehandling, bad, kroppsbehandling, par-spa, dagspakker. Spør behandlingstype, antall personer.',
  'baderomsfliser': 'BADEROMSFLISER: Tilbyr: flislegging bad, membran, gulvvarme, rehabilitering, våtrom. Spør nytt/gammelt bad, størrelse.',
  'stoeping': 'STØPING: Tilbyr: støping, betong, grunnmur, gulvplater, trapper, ringmur, påstøp. Spør type arbeid, areal, grunnforhold.',
  'kjokken': 'KJØKKEN: Tilbyr: nytt kjøkken, montering, benkeplate, fronter, hvitevarer, design. Spør nytt/oppgradering, omfang.',
  'taktekker': 'TAKTEKKER: Tilbyr: taktekking, reparasjon, takstein, skifer, stålplater, beslag, takrenner. Spør type tak, areal.',
  'snekker': 'SNEKKER: Tilbyr: tømrerarbeid, tilbygg, terrasse, innredning, kledning, reparasjon, garasje. Spør type jobb, omfang.',
  'murer': 'MURER: Tilbyr: murarbeid, peis, pipe, pussing, flislegging, grunnmur, fasade. Spør type arbeid, omfang.',
  'glassmester': 'GLASSMESTER: Tilbyr: vindusglass, dusjvegger, glassdører, speil, innglassing. Spør type glass, antall, mål.',
  'hage': 'HAGE: Tilbyr: hagearbeid, anlegg, beplantning, beskjæring, plen, steinlegging, gjerde. Spør type arbeid, areal.',
  'vinduer': 'VINDUER: Tilbyr: vinduer, dører, montering, utskifting, energiglass, balkongdør. Spør type, antall, ny/utskifting.',
  'varmepumpe': 'VARMEPUMPE: Tilbyr: luft-luft, luft-vann, bergvarme, installasjon, service, reparasjon. Spør type pumpe, boligtype.',
  'solceller': 'SOLCELLER: Tilbyr: solcellepanel, installasjon, batteri, lading, prosjektering. Spør takareal, takretning.',
  'bronnboring': 'BRØNNBORING: Tilbyr: brønnboring, energibrønn, vannbrønn, boring i fjell. Spør formål, grunntype.',
  'gravearbeid': 'GRAVEARBEID: Tilbyr: graving, grøfting, planering, tomtegraving, VA-anlegg, sprengning. Spør type jobb, omfang.',
  'transport': 'TRANSPORT: Tilbyr: flytting, varetransport, lagring, pakking, kontorflytting. Spør fra/til, mengde.',
  'renovering': 'RENOVERING: Tilbyr: totalrenovering, bad, kjøkken, oppussing, tilbygg, fasade. Spør hva som renoveres, omfang.',
  'bilvask': 'BILVASK: Tilbyr: utvendig vask, innvendig rens, polering, keramisk coating, lakkforsegling. Spør type vask, biltype.',
  'bilverksted': 'BILVERKSTED: Tilbyr: service, EU-kontroll, dekkskift, bremser, motor, karosseri. Spør type jobb, bilmerke.',
  'veterinar': 'VETERINÆR: Tilbyr: konsultasjon, vaksinering, operasjon, tannbehandling, akutt. Spør dyretype, symptomer.',
  'fotograf': 'FOTOGRAF: Tilbyr: portrett, bryllup, bedriftsfoto, produktfoto, eiendomsfoto, konfirmasjon. Spør type foto, sted.',
  'trening': 'TRENING: Tilbyr: personlig trener, treningsprogram, kostholdsveiledning, gruppetimer. Spør mål, erfaring.',
  'regnskap': 'REGNSKAP: Tilbyr: løpende regnskap, årsoppgjør, mva, lønn, fakturering, rådgivning. Spør selskapstype, tjeneste.',
  'advokat': 'ADVOKAT: Tilbyr: eiendomsrett, arv, familierett, arbeidsrett, kontrakt, strafferett. Spør rettsområde, hast.',
  'it': 'IT: Tilbyr: support, nettside, nettverk, sky, sikkerhet, programvare, serverdrift. Spør type problem, privat/bedrift.',
  'sikkerhet': 'SIKKERHET: Tilbyr: alarm, kamera, adgangskontroll, vakthold, brannvarsling. Spør type tjeneste, bolig/næring.',
  'skadedyr': 'SKADEDYR: Tilbyr: skadedyrkontroll, mus, rotter, maur, kakerlakker, veggedyr, veps. Spør type skadedyr, omfang.',
  'tekstil': 'TEKSTIL: Tilbyr: omsøm, reparasjon, nysøm, skreddersy, tilpasning, gardiner. Spør type arbeid, plagg.',
  'tatovering': 'TATOVERING: Tilbyr: tatovering, cover-up, touch-up, fjerning, design. Spør plassering, størrelse.',
  'blomster': 'BLOMSTER: Tilbyr: buketter, brudebukett, dekorasjon, sorgbinding, arrangement. Spør anledning, stil.',
  'catering': 'CATERING: Tilbyr: selskapsmat, buffet, koldtbord, kake, firmamiddag, bryllup. Spør anledning, antall gjester.',
  'hudpleie': 'HUDPLEIE: Tilbyr: ansiktsbehandling, peeling, lys/laser, anti-age, aknebehandling. Spør behandlingstype, hudtype.',
  'negler': 'NEGLER: Tilbyr: manikyr, pedikyr, gelenegler, akryl, negledesign, shellac. Spør type behandling.',
  'optiker': 'OPTIKER: Tilbyr: synstest, briller, kontaktlinser, solbriller, reparasjon. Spør tjeneste, siste synstest.',
  'tannlege': 'TANNLEGE: Tilbyr: undersøkelse, tannrens, fylling, krone, implantat, bleking. Spør type tjeneste, hast.',
  'fysioterapi': 'FYSIOTERAPI: Tilbyr: behandling, rehabilitering, trening, manuellterapi, akupunktur. Spør plager, varighet.',
  'takst': 'TAKST: Tilbyr: boligtaksering, tilstandsrapport, skadetakst, verditaksering. Spør type takst, boligtype.',
  'eiendom': 'EIENDOM: Tilbyr: salg, kjøp, utleie, verdivurdering, boligstyling, visning. Spør kjøp/salg, boligtype.',
  'renseriet': 'RENSERI: Tilbyr: kjemisk rens, dress, kjoler, skinn, gardiner, dundyner. Spør plaggtype, mengde.',
};

// ===== Required base fields =====
const REQUIRED_FIELDS = ['navn', 'adresse', 'dato', 'klokkeslett'];

// ===== Build system prompt for the AI =====
function buildSystemPrompt(company, collectedData, industry, activeImprovements) {
  const missingBase = REQUIRED_FIELDS.filter(f => !collectedData[f]);
  const hasProblem = !!collectedData['problem'];

  // Only base fields + problem are REQUIRED. Industry questions are bonus — ask if natural, skip if not.
  const allMissing = [...(hasProblem ? [] : ['problem']), ...missingBase];
  const collectedSummary = Object.entries(collectedData).filter(([k,v]) => v).map(([k,v]) => `${k}: ${v}`).join(', ');

  let prompt = `K.I.-assistent for ${company.name} (${industry}).

REGLER: Bekreft kundens svar kort, still ETT spørsmål. Maks 1-2 setninger. Svar på bokmål. Svar på spørsmål FØR info-innhenting. "ja"/"hei" er IKKE gyldig behov.
ANTI-DOBBELTORD: Sjekk HVER setning — ALDRI bruk samme ord to ganger etter hverandre ("klokka klokka", "og og", "til til" osv). Les svaret ditt og fjern duplikater FØR du sender.
TALL: Telefonnummer siffer for siffer: "9-8-8-8-8-8-8-8". Klokkeslett UTEN kolon — si "klokka 8 30" IKKE "08:30", si "klokka 19" IKKE "19:00". Si tider rett fram og naturlig.
ÅPNINGSTIDER: Grupper dager med like tider — si "mandag og onsdag klokka 8 30 til 19, tirsdag, torsdag og fredag klokka 8 30 til 16 30" — ALDRI ramse opp hver dag separat.
UTTALE: Engelske ord (extensions, highlights, balayage, microblading, microshading) uttales ENERGISK på engelsk — IKKE les dem som norske ord.

STT-FIX: Deepgram hører feil — bruk kontekst ALLTID. Adresser: "stor gata"=Storgata, "nedre gata"=Nedregata, "over gata"=Overgata, "lang gata"=Langgata. Tid: "halv tre"=14:30, "kvart over fire"=16:15, "etter jobb"=ca 16-17, "halv åtte"=07:30/19:30(bruk kontekst), "kvart på"=kvart på(trekk fra 15min). Tall: "fire og tjue"=24, "to og tredve"=32.
DIALEKTER: Gudbrandsdal/Østerdal: æ/je=jeg, mæ/me=meg, dæ/de=deg, ikkje/itj=ikke, ka/kva=hva, kor=hvor, kåssen=hvordan, golv=gulv, nå=noe, dom=de/dem, ha'kke=har ikke, ska'kke=skal ikke, veit=vet, heime=hjemme, bort'i=bort i, inni=inn i. Trøndersk: e=jeg, ke/ka=hva, kor=hvor, itj=ikke, mæ=meg, sjøl=selv. Vestlandsk: eg=jeg, ikkje=ikke, kva=hva. Nord-norsk: æ=jeg, hansen=hansen, korsen=hvordan, itj=ikke, gansen=ganske.
ENGELSKE STT-FEIL: "yeah"=ja, "I will"=jeg vil, "the"=de, "and"=and/en, "like"=liksom, "you know"=vet du. Navn: STT kan feiltolke — spør "Kan du stave fornavnet?" ved uvanlige navn.
UKLAR TALE: Hører du dårlig? Be kunden vennlig snakke litt saktere og tydeligere. Ved adresse: spør om postnummer eller sted for å verifisere. Gjett ALDRI — spør heller én gang til. Aldri si "beklager jeg forstod ikke" mer enn 2 ganger — prøv å gjette fra kontekst etter 2. forsøk.

FLYT: 1.Behov → 2.Bransjespørsmål(kun 1-2 relevante) → 3.Navn → 4.Adresse(+postnr) → 5.Dato → 6.Tidsrom("Er du ledig hele dagen, eller har du et bestemt tidsrom?") → 7.AVSLUTT UMIDDELBART: "Tusen takk! Vi kommer tilbake til deg med bekreftelse på tidspunkt. Ha en fin dag!"
KRITISK: Når dato+tidsrom er samlet → SI AVSLUTNINGEN OG SETT d=true. ALDRI still flere spørsmål etter tidsrom. ALDRI gjenta spørsmål du allerede har svar på. Si avslutningen KUN ÉN gang.
Telefon hentes automatisk — ALDRI spør om telefonnummer. Flerinfo i én setning? Samle alt, hopp over utfylte steg. Sjekk SAMLET — spør ALDRI om noe som allerede er samlet.

${company.system_prompt ? company.system_prompt : (INDUSTRY_PROMPTS[industry] || INDUSTRY_PROMPTS['generell'])}
SAMLET: ${collectedSummary || 'Ingenting'}  MANGLER: ${allMissing.length > 0 ? allMissing.join(', ') : 'Alt samlet!'}
Hast/lekkasje/skade → spør detaljer, lagre i "spesielle_notater". Spør hvem laget AI → "Utviklet av Tobias Bjørkhaug. Skal jeg koble deg til ham?" → transfer_to_creator=true`;

  // Add active improvements from auto-learning (max 5 most recent to keep prompt short)
  if (activeImprovements && activeImprovements.length > 0) {
    const topImprovements = activeImprovements.slice(0, 5);
    prompt += '\n\nEKSTRA REGLER:\n';
    topImprovements.forEach(imp => {
      prompt += `- ${imp.description}\n`;
    });
  }

  prompt += `\n\nJSON: {"r":"svar","c":{"felt":"verdi"},"d":false,"s":null}
c=nye felt, d=true når ALT samlet, s=oppsummering kun når d=true`;

  return prompt;
}


// ===== Process a customer message =====
async function processMessage(company, sessionData, customerMessage, activeImprovements) {
  const collectedData = JSON.parse(sessionData.collected_data || '{}');
  const history = JSON.parse(sessionData.conversation_history || '[]');
  const industry = company.industry || 'generell';

  history.push({ role: 'user', content: customerMessage });

  // SPEED: Keep only last 8 messages to limit prompt size
  const trimmedHistory = history.length > 8 ? history.slice(-8) : history;

  const systemPrompt = buildSystemPrompt(company, collectedData, industry, activeImprovements || []);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...trimmedHistory,
      ],
      temperature: 0.2,
      max_tokens: 80,
    });

    const raw = completion.choices[0].message.content;
    let aiResponse;
    try {
      // Try to extract JSON from response (GPT might wrap it in markdown)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      aiResponse = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch(e) {
      // If JSON parse fails, treat entire response as text
      aiResponse = { r: raw, c: {}, d: false, s: null };
    }

    // Support both short keys (r,c,d,s) and long keys (response,collected,complete,summary)
    const responseText = aiResponse.r || aiResponse.response || raw;
    const collected = aiResponse.c || aiResponse.collected || {};
    const complete = aiResponse.d || aiResponse.complete || false;
    const summary = aiResponse.s || aiResponse.summary || null;

    // Merge newly collected data
    if (collected && typeof collected === 'object') {
      Object.assign(collectedData, collected);
    }

    // Store ONLY the text response — NOT raw JSON — so GPT sees natural conversation history
    history.push({ role: 'assistant', content: responseText });

    return {
      response: responseText,
      collectedData,
      conversationHistory: history,
      complete: complete,
      summary: summary,
    };
  } catch (error) {
    console.error('OpenAI error:', error?.message || error);
    console.error('OpenAI error details:', JSON.stringify({ status: error?.status, code: error?.code, type: error?.type }, null, 2));
    return {
      response: 'Beklager, jeg opplevde en teknisk feil. Kan du gjenta det du sa?',
      collectedData,
      conversationHistory: history,
      complete: false,
      summary: null,
    };
  }
}

// ===== Verify collected data (pre-check) =====
function verifyCollectedData(collectedData, industry) {
  const missing = [];
  
  // Only problem + base fields are required. Industry questions are bonus.
  if (!collectedData['problem']) missing.push('problem');

  for (const field of REQUIRED_FIELDS) {
    if (!collectedData[field]) missing.push(field);
  }

  return {
    isComplete: missing.length === 0,
    missingFields: missing,
    data: collectedData,
  };
}

// ===== Handle spontaneous/irrelevant input =====
function detectSpontaneousInput(message) {
  const topicKeywords = {
    planke: ['planke', 'gulv', 'tre', 'materiale', 'terrasse', 'bad'],
    vaskeri: ['vask', 'klær', 'tekstil', 'rens'],
    kosmetikk: ['hud', 'sminke', 'behandling', 'ansikt'],
    rorlegging: ['rør', 'lekkasje', 'vann', 'avløp', 'toalett', 'dusj', 'kran'],
    elektriker: ['strøm', 'sikring', 'lys', 'stikkontakt', 'ledning'],
    maler: ['maling', 'male', 'vegg', 'tak', 'fasade'],
    antikviteter: ['antik', 'antikvitet', 'samler', 'vintage', 'møbel', 'arv'],
    frisor: ['frisør', 'hår', 'klipp', 'farge', 'salong'],
  };

  const lowerMsg = message.toLowerCase();
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(kw => lowerMsg.includes(kw))) {
      return { isRelevant: true, topic };
    }
  }

  if (lowerMsg.length > 50 && !lowerMsg.includes('?')) {
    return { isRelevant: false, topic: null };
  }

  return { isRelevant: true, topic: null };
}

module.exports = {
  processMessage,
  verifyCollectedData,
  detectSpontaneousInput,
  INDUSTRY_PROMPTS,
  REQUIRED_FIELDS,
};

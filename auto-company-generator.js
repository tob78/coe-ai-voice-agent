// auto-company-generator.js — Generates industry-specific config for new companies
// Used by POST /api/companies to auto-populate industry questions, follow-up triggers, etc.

// Brreg integration for auto company setup
let brregLookup;
try {
  const registry = require('./registry-lookup');
  brregLookup = registry.lookupBrregCompany || registry.searchBrregCompany;
} catch(e) {}

const INDUSTRY_CONFIG = {
  // === BYGG & HÅNDVERK ===
  rørlegger: {
    questions: ['Hva slags rørleggerarbeid trenger du?', 'Er det akutt lekkasje eller planlagt arbeid?'],
    triggers: { lekkasje: 'Har du mulighet til å stenge vannet?', akutt: 'Hvor alvorlig er situasjonen?' },
    routines: ['Sjekk vanntilførsel', 'Ta med standard rørleggerverktøy'],
    sms: '📞 Ny rørleggerjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  elektriker: {
    questions: ['Hva slags elektrisk arbeid trenger du?', 'Er det noe som er akutt/farlig?'],
    triggers: { kortslutning: 'Er sikringen slått ut?', nyinstallasjon: 'Hva slags installasjon?' },
    routines: ['Sjekk sikringsskap', 'Ta med multimeter'],
    sms: '📞 Ny elektrikerjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  maler: {
    questions: ['Hva skal males?', 'Hvor mange rom/flater gjelder det?'],
    triggers: { utvendig: 'Hva slags fasade er det?', innvendig: 'Har du valgt farge?' },
    routines: ['Sjekk underlag', 'Mål opp flater'],
    sms: '📞 Ny malerjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  snekker: {
    questions: ['Hva slags snekkerarbeid trenger du?', 'Er det innvendig eller utvendig?'],
    triggers: { terrasse: 'Hvor stor terrasse?', kjøkken: 'Nytt kjøkken eller oppgradering?' },
    routines: ['Ta mål', 'Sjekk materialbehov'],
    sms: '📞 Ny snekkerjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  murer: {
    questions: ['Hva slags murerarbeid trenger du?', 'Er det nybygg eller reparasjon?'],
    triggers: { peis: 'Hva slags peis ønskes?', fasade: 'Hvor stort areal?' },
    routines: ['Sjekk grunnmur', 'Vurder materialvalg'],
    sms: '📞 Ny murerjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  taktekker: {
    questions: ['Hva slags takarbeid trenger du?', 'Er det lekkasje?'],
    triggers: { lekkasje: 'Hvor lekker det?', nytt_tak: 'Hva slags taktype?' },
    routines: ['Sjekk takflater', 'Vurder isolasjon'],
    sms: '📞 Ny takjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  flis: {
    questions: ['Hva slags flisarbeid trenger du?', 'Hvilket rom gjelder det?'],
    triggers: { bad: 'Skal det gjøres membranarbeid også?', gulv: 'Hva slags flis?' },
    routines: ['Mål opp flater', 'Sjekk underlag'],
    sms: '📞 Ny flisjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  gulvlegger: {
    questions: ['Hva slags gulv ønsker du?', 'Hvor mange kvadratmeter?'],
    triggers: { parkett: 'Sliping eller nytt gulv?', vinyl: 'Hva slags underlag?' },
    routines: ['Mål opp rom', 'Sjekk fuktighet i undergulv'],
    sms: '📞 Ny gulvjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  glassarbeid: {
    questions: ['Hva slags glassarbeid trenger du?', 'Er det knust glass/akutt?'],
    triggers: { knust: 'Mål på glasset?', nytt: 'Hva slags glass ønskes?' },
    routines: ['Ta mål', 'Bestill glass'],
    sms: '📞 Ny glassjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  // === HJEM & HAGE ===
  renhold: {
    questions: ['Hva slags renhold trenger du?', 'Hvor stort areal?'],
    triggers: { flyttevask: 'Når skal det være ferdig?', kontor: 'Hvor ofte?' },
    routines: ['Sjekk utstyrsbehov', 'Avtal nøkkeloverlevering'],
    sms: '📞 Ny renholdsjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  vaktmester: {
    questions: ['Hva slags vaktmesterarbeid trenger du?', 'Er det en bolig eller bedrift?'],
    triggers: {},
    routines: ['Ta med standard verktøy'],
    sms: '📞 Ny vaktmesterjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  hagearbeid: {
    questions: ['Hva slags hagearbeid trenger du?', 'Hvor stort område?'],
    triggers: { trefall: 'Hvor stort tre?', plen: 'Ønskes vedlikeholdsavtale?' },
    routines: ['Sjekk utstyrsbehov'],
    sms: '📞 Ny hagejobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  flytting: {
    questions: ['Hvor skal du flytte fra og til?', 'Omtrent hvor mye skal flyttes?'],
    triggers: { piano: 'Har dere heis?', langt: 'Hvilken by flyttes det til?' },
    routines: ['Vurder bilstørrelse', 'Sjekk adkomst'],
    sms: '📞 Ny flyttejobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  // === KJØRETØY ===
  bilverksted: {
    questions: ['Hva slags bilarbeid trenger du?', 'Hva slags bil har du?'],
    triggers: { eu_kontroll: 'Når utløper EU-kontrollen?', motor: 'Hva slags symptomer?' },
    routines: ['Sjekk deler på lager'],
    sms: '📞 Ny bilverkstedjobb! {service} — {name}. Dato: {date} {time}'
  },
  dekkskift: {
    questions: ['Skal det byttes til sommer- eller vinterdekk?', 'Hva slags bil?'],
    triggers: {},
    routines: ['Sjekk dekkhotell'],
    sms: '📞 Nytt dekkskift! {service} — {name}. Dato: {date} {time}'
  },
  bilpleie: {
    questions: ['Hva slags bilpleie ønskes?', 'Hva slags bil har du?'],
    triggers: {},
    routines: ['Sjekk tilgjengelige produkter'],
    sms: '📞 Ny bilpleietime! {service} — {name}. Dato: {date} {time}'
  },
  // === HELSE & VELVÆRE ===
  frisør: {
    questions: ['Hva slags behandling ønsker du?', 'Har du en foretrukket frisør?'],
    triggers: { farge: 'Hva slags farge/teknikk?', extensions: 'Hva slags extensions?' },
    routines: ['Sjekk booking-kalender'],
    sms: '📞 Ny frisørtime! {service} — {name}. Dato: {date} {time}'
  },
  hudpleie: {
    questions: ['Hva slags hudpleie ønsker du?', 'Har du noen allergier?'],
    triggers: { allergi: 'Hva er du allergisk mot?', akne: 'Hvor lenge har du hatt det?' },
    routines: ['Sjekk produkter'],
    sms: '📞 Ny hudpleietime! {service} — {name}. Dato: {date} {time}'
  },
  massasje: {
    questions: ['Hva slags massasje ønsker du?', 'Har du noen skader eller plager?'],
    triggers: { skade: 'Hva slags skade?', gravid: 'Hvor langt på vei?' },
    routines: [],
    sms: '📞 Ny massasjetime! {service} — {name}. Dato: {date} {time}'
  },
  tannlege: {
    questions: ['Hva er grunnen til timen?', 'Har du akutte smerter?'],
    triggers: { akutt: 'Hvor sterke smerter på en skala 1-10?' },
    routines: ['Sjekk journal'],
    sms: '📞 Ny tannlegetime! {service} — {name}. Dato: {date} {time}'
  },
  fysioterapi: {
    questions: ['Hva slags plager har du?', 'Har du vært til fysioterapi før?'],
    triggers: { skade: 'Når skjedde skaden?', kronisk: 'Har du henvisning fra lege?' },
    routines: ['Sjekk journal'],
    sms: '📞 Ny fysioterapitime! {service} — {name}. Dato: {date} {time}'
  },
  kiropraktor: {
    questions: ['Hva slags plager har du?', 'Er det første besøk?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny kiropraktortime! {service} — {name}. Dato: {date} {time}'
  },
  fotpleie: {
    questions: ['Hva slags fotpleie ønsker du?', 'Har du spesielle behov?'],
    triggers: { diabetes: 'Har du diabetes-relaterte fotproblemer?' },
    routines: [],
    sms: '📞 Ny fotpleietime! {service} — {name}. Dato: {date} {time}'
  },
  negledesign: {
    questions: ['Hva slags neglebehandling ønsker du?', 'Har du allergier mot negleprodukter?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny negletime! {service} — {name}. Dato: {date} {time}'
  },
  // === MAT & DRIKKE ===
  catering: {
    questions: ['Hva slags arrangement er det?', 'Omtrent hvor mange gjester?'],
    triggers: { allergier: 'Er det noen allergier eller diettbehov?', stort: 'Trengs det servitører?' },
    routines: ['Sjekk meny', 'Vurder kapasitet'],
    sms: '📞 Ny cateringforespørsel! {service} — {name}. Dato: {date} {time}. Antall: {notes}'
  },
  restaurant: {
    questions: ['Hvor mange gjester?', 'Er det en spesiell anledning?'],
    triggers: { allergi: 'Hva slags allergier?', selskap: 'Ønskes eget rom?' },
    routines: ['Sjekk kapasitet'],
    sms: '📞 Ny reservasjon! {service} — {name}. Dato: {date} {time}'
  },
  bakeri: {
    questions: ['Hva ønsker du å bestille?', 'Når trenger du det?'],
    triggers: { bryllup: 'Hva slags kake?', allergi: 'Hva er du allergisk mot?' },
    routines: [],
    sms: '📞 Ny bakeribestilling! {service} — {name}. Dato: {date} {time}'
  },
  // === TEKNOLOGI ===
  it_support: {
    questions: ['Hva slags IT-problem har du?', 'Gjelder det privat eller bedrift?'],
    triggers: { akutt: 'Er systemet helt nede?', virus: 'Hva skjer på skjermen?' },
    routines: ['Sjekk fjernstyringsverktøy'],
    sms: '📞 Ny IT-support! {service} — {name}. Dato: {date} {time}'
  },
  // === JURIDISK & ØKONOMI ===
  advokat: {
    questions: ['Hva slags juridisk hjelp trenger du?', 'Er det haster?'],
    triggers: {},
    routines: ['Sjekk konfliktsjekk'],
    sms: '📞 Ny advokathenvendelse! {service} — {name}. Dato: {date} {time}'
  },
  regnskapsfører: {
    questions: ['Hva slags regnskapshjelp trenger du?', 'Er det privat eller bedrift?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny regnskapshenvendelse! {service} — {name}. Dato: {date} {time}'
  },
  // === EIENDOM ===
  eiendomsmegler: {
    questions: ['Ønsker du å selge eller kjøpe?', 'Hva slags eiendom gjelder det?'],
    triggers: {},
    routines: ['Sjekk markedsdata'],
    sms: '📞 Ny eiendomshenvendelse! {service} — {name}. Dato: {date} {time}'
  },
  takstmann: {
    questions: ['Hva slags takst trenger du?', 'Hva slags eiendom?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny takstforespørsel! {service} — {name}, {address}. Dato: {date} {time}'
  },
  // === DYR ===
  veterinær: {
    questions: ['Hva slags dyr gjelder det?', 'Hva er problemet?'],
    triggers: { akutt: 'Er dyret i akutt smerte?' },
    routines: ['Sjekk journal'],
    sms: '📞 Ny veterinærtime! {service} — {name}. Dato: {date} {time}'
  },
  hundefrisør: {
    questions: ['Hva slags rase?', 'Hva slags klipp ønskes?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny hundeklipptime! {service} — {name}. Dato: {date} {time}'
  },
  // === TRANSPORT ===
  taxi: {
    questions: ['Hvor skal du hentes og kjøres til?', 'Når trenger du transport?'],
    triggers: { flyplass: 'Hvilket fly?', rullestol: 'Trenger du spesialtilpasset bil?' },
    routines: [],
    sms: '📞 Ny taxibestilling! {service} — {name}. Dato: {date} {time}'
  },
  // === FOTO & MEDIA ===
  fotograf: {
    questions: ['Hva slags fotografering?', 'Når og hvor?'],
    triggers: { bryllup: 'Hvor mange timer ønskes?', bedrift: 'Hva slags bilder?' },
    routines: ['Sjekk utstyr'],
    sms: '📞 Ny fotobestilling! {service} — {name}. Dato: {date} {time}'
  },
  // === OPPLÆRING ===
  kjøreskole: {
    questions: ['Hva slags førerkort tar du?', 'Har du kjørt før?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny kjøretimeforespørsel! {service} — {name}. Dato: {date} {time}'
  },
  // === DIVERSE ===
  låsesmed: {
    questions: ['Hva trenger du hjelp med?', 'Er du utestengt nå?'],
    triggers: { akutt: 'Er du innelåst?' },
    routines: ['Ta med universalnøkler'],
    sms: '📞 Ny låsesmedjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  skadedyr: {
    questions: ['Hva slags skadedyr?', 'Hvor er problemet?'],
    triggers: { akutt: 'Er det mange?' },
    routines: ['Sjekk utstyr og gift'],
    sms: '📞 Ny skadedyrjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  varmepumpe: {
    questions: ['Hva trenger du hjelp med?', 'Hva slags varmepumpe?'],
    triggers: { ny: 'Hva slags bolig?', service: 'Hvor lenge siden sist service?' },
    routines: ['Sjekk modell og deler'],
    sms: '📞 Ny varmepumpejobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  ventilasjon: {
    questions: ['Hva trenger du hjelp med?', 'Hva slags anlegg?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny ventilasjonsjobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  solceller: {
    questions: ['Er du interessert i solceller for bolig eller bedrift?', 'Hva slags tak har du?'],
    triggers: {},
    routines: ['Vurder takflate og retning'],
    sms: '📞 Ny solcelleforespørsel! {service} — {name}, {address}. Dato: {date} {time}'
  },
  brønnboring: {
    questions: ['Hva er formålet med brønnen?', 'Hva slags grunn er det?'],
    triggers: {},
    routines: ['Sjekk grunnforhold'],
    sms: '📞 Ny brønnboringsforespørsel! {service} — {name}, {address}. Dato: {date} {time}'
  },
  markise: {
    questions: ['Hva slags markise ønsker du?', 'Hvor skal den monteres?'],
    triggers: {},
    routines: ['Ta mål'],
    sms: '📞 Ny markisejobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  persienner: {
    questions: ['Hva slags solskjerming ønsker du?', 'Hvor mange vinduer?'],
    triggers: {},
    routines: ['Ta mål på vinduer'],
    sms: '📞 Ny persiennejobb! {service} — {name}, {address}. Dato: {date} {time}'
  },
  sikkerhet: {
    questions: ['Hva slags sikkerhetssystem trenger du?', 'Er det bolig eller bedrift?'],
    triggers: {},
    routines: ['Vurder behov'],
    sms: '📞 Ny sikkerhetsforespørsel! {service} — {name}, {address}. Dato: {date} {time}'
  },
  gravstein: {
    questions: ['Hva slags gravstein ønskes?', 'Er det en ny gravstein eller vedlikehold?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny gravsteinforespørsel! {service} — {name}. Dato: {date} {time}'
  },
  piano: {
    questions: ['Hva trenger du hjelp med?', 'Hva slags piano har du?'],
    triggers: {},
    routines: [],
    sms: '📞 Ny pianoforespørsel! {service} — {name}, {address}. Dato: {date} {time}'
  },
};

// Default config for unknown/generell industries
const DEFAULT_CONFIG = {
  questions: ['Hva kan vi hjelpe deg med?'],
  triggers: {},
  routines: [],
  sms: '📞 Ny henvendelse! {service} — {name}. Dato: {date} {time}'
};

function generateCompanyConfig(companyName, industry) {
  const key = (industry || 'generell').toLowerCase().trim();
  const config = INDUSTRY_CONFIG[key] || DEFAULT_CONFIG;
  
  return {
    industryQuestions: config.questions || DEFAULT_CONFIG.questions,
    followUpTriggers: config.triggers || {},
    standardRoutines: config.routines || [],
    smsTemplate: (config.sms || DEFAULT_CONFIG.sms)
  };
}

// ===== AUTO-ENRICH COMPANY FROM BRREG =====
async function enrichCompanyFromBrreg(orgNumber) {
  if (!brregLookup) return null;
  try {
    const { lookupBrregCompany } = require('./registry-lookup');
    const info = await lookupBrregCompany(orgNumber);
    if (!info) return null;
    
    return {
      name: info.name,
      org_number: info.org_number,
      industry: mapBrregIndustryToOurIndustry(info.industry_code, info.industry),
      address: info.address ? `${info.address.street}, ${info.address.postal_code} ${info.address.postal_place}` : null,
      website: info.website,
      employee_count: info.employee_count
    };
  } catch(e) {
    console.error('Brreg enrichment error:', e.message);
    return null;
  }
}

function mapBrregIndustryToOurIndustry(code, description) {
  // Map NACE codes to our industry types
  const mapping = {
    '43.22': 'rørlegger', '43.21': 'elektriker', '43.34': 'maler',
    '43.32': 'snekker', '43.31': 'murer', '43.91': 'taktekker',
    '43.33': 'flis', '43.3': 'gulvlegger', '96.02': 'frisør',
    '56.21': 'catering', '56.10': 'restaurant', '96.04': 'spa',
    '86.23': 'tannlege', '86.90': 'helse', '45.20': 'bilverksted',
    '81.21': 'renhold', '49.42': 'flytting', '81.30': 'hagearbeid'
  };
  
  for (const [nace, industry] of Object.entries(mapping)) {
    if (code?.startsWith(nace)) return industry;
  }
  
  // Fallback: try to match description
  const desc = (description || '').toLowerCase();
  if (desc.includes('rørlegg')) return 'rørlegger';
  if (desc.includes('elektr')) return 'elektriker';
  if (desc.includes('frisør') || desc.includes('salong')) return 'frisør';
  if (desc.includes('cater')) return 'catering';
  if (desc.includes('snekker') || desc.includes('tømr')) return 'snekker';
  
  return null; // Will need manual industry selection
}

module.exports = { generateCompanyConfig, INDUSTRY_CONFIG, enrichCompanyFromBrreg };

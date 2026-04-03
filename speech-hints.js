// speech-hints.js — Massive Norwegian speech hints for Twilio Gather
// Max 500 phrases per Twilio docs
// v1.0.0

// ============================================================
// NORWEGIAN FIRST NAMES (100 most common + variations)
// ============================================================
const FIRST_NAMES = [
  // Male names
  'Jan', 'Per', 'Bjørn', 'Ole', 'Lars', 'Kjell', 'Arne', 'Knut', 'Svein', 'Thomas',
  'Erik', 'Tor', 'Harald', 'Geir', 'Odd', 'Helge', 'Terje', 'Rune', 'Morten', 'Hans',
  'Trond', 'Leif', 'Øyvind', 'Ståle', 'Steinar', 'Dag', 'Magnus', 'Anders', 'Einar', 'Sigurd',
  'Olav', 'Ivar', 'Gunnar', 'Nils', 'Rolf', 'Asbjørn', 'Håkon', 'Jostein', 'Vidar', 'Torbjørn',
  'Kristian', 'Jon', 'Kåre', 'Arild', 'Ragnar', 'Petter', 'Stian', 'Sondre', 'Tobias', 'Henrik',
  'Martin', 'Aleksander', 'Espen', 'Vegard', 'Erlend', 'Kenneth', 'Sindre', 'Øystein', 'Jarle', 'Frode',
  // Female names
  'Anne', 'Inger', 'Kari', 'Marit', 'Ingrid', 'Liv', 'Eva', 'Berit', 'Astrid', 'Bjørg',
  'Hilde', 'Anna', 'Solveig', 'Marianne', 'Randi', 'Gerd', 'Wenche', 'Bente', 'Tone', 'Linda',
  'Silje', 'Hege', 'Kristin', 'Turid', 'Lene', 'Heidi', 'Vigdis', 'Siri', 'Camilla', 'Nina',
  'Ida', 'Gunnhild', 'Ragnhild', 'Sigrid', 'Gudrun', 'Magnhild', 'Torunn', 'Borgny', 'Dagny', 'Eldbjørg',
  'Åse', 'Tove', 'Eli', 'Jorunn', 'Laila', 'Kirsten', 'Mona', 'Else', 'Unni', 'Anita',
  'Nora', 'Emma', 'Sofie', 'Emilie', 'Thea', 'Maja', 'Sara', 'Lea', 'Julie', 'Vilde'
];

// ============================================================
// NORWEGIAN SURNAMES (100 common + rural/farm names)
// ============================================================
const SURNAMES = [
  // Common surnames
  'Hansen', 'Johansen', 'Olsen', 'Larsen', 'Andersen', 'Pedersen', 'Nilsen', 'Kristiansen',
  'Jensen', 'Karlsen', 'Johnsen', 'Pettersen', 'Eriksen', 'Berg', 'Haugen', 'Hagen',
  'Johannessen', 'Andreassen', 'Jacobsen', 'Dahl', 'Jørgensen', 'Henriksen', 'Lund', 'Halvorsen',
  'Sørensen', 'Jakobsen', 'Moen', 'Gundersen', 'Iversen', 'Strand', 'Solberg', 'Martinsen',
  'Eide', 'Bakken', 'Kristoffersen', 'Mathisen', 'Lie', 'Amundsen', 'Nguyen', 'Rasmussen',
  'Lien', 'Berge', 'Moe', 'Nygård', 'Fredriksen', 'Holm', 'Knudsen', 'Svendsen',
  // Rural/farm names (often misheard by STT)
  'Bjørkhaug', 'Blakarstugun', 'Blakar', 'Kvam', 'Hegge', 'Bøvre', 'Garmo', 'Vågå',
  'Lom', 'Skjåk', 'Sel', 'Dovre', 'Lesja', 'Ringebu', 'Øyer', 'Gausdal',
  'Fåberg', 'Biri', 'Gjøvik', 'Lillehammer', 'Vinstra', 'Otta', 'Dombås', 'Hjerkinn',
  'Tretten', 'Fåvang', 'Hundorp', 'Kvitfjell', 'Sjoa', 'Heidal', 'Randsverk', 'Beitostølen',
  'Stugu', 'Øygard', 'Nordgard', 'Sørgard', 'Uppigard', 'Nigard', 'Framigard', 'Bakigard',
  'Haugli', 'Rusten', 'Sletten', 'Jordet', 'Engen', 'Sveen', 'Bråten', 'Løken',
  'Grønli', 'Ødegård', 'Nordby', 'Søndre', 'Nordre', 'Østre', 'Vestre', 'Øvre',
  'Nedre', 'Mellem', 'Indre', 'Ytre', 'Austre', 'Heimdal', 'Brenna', 'Myhr'
];

// ============================================================
// STREET NAMES (most common Norwegian patterns)
// ============================================================
const STREETS = [
  'Storgata', 'Kirkegata', 'Kongens gate', 'Dronningens gate', 'Torggata', 'Skippergata',
  'Grensen', 'Karl Johans gate', 'Bogstadveien', 'Bygdøy allé', 'Thereses gate',
  'Markveien', 'Toftes gate', 'Sannergata', 'Uelands gate', 'Fredensborgveien',
  'Hovedveien', 'Industriveien', 'Fjordveien', 'Sjøgata', 'Havnegata', 'Strandgata',
  'Skolegata', 'Parkveien', 'Ringveien', 'Gamleveien', 'Nyveien', 'Kirkebakken',
  // Common suffixes customers say
  'gata', 'veien', 'vegen', 'gate', 'vei', 'veg', 'allé', 'plass', 'torg',
  'bakken', 'lia', 'haugen', 'åsen', 'berget', 'sletta', 'jordet', 'engen', 'myra',
  'stulen', 'sætra', 'vollen', 'neset', 'odden', 'holmen', 'øya', 'sundet',
  // Gudbrandsdal-specific
  'Kjerringdokka', 'Strandgata Vinstra', 'Lia', 'Liavegen', 'Fåberggata', 'Mesnavegen',
  'Gutulien', 'Rustevegen', 'Gardvegen', 'Kvamsvegen', 'Nedregata',
  'Elvegata', 'Jernbanegata', 'Brugata', 'Moavegen', 'Kvamsvegen'
];

// ============================================================
// CITIES AND PLACES
// ============================================================
const CITIES = [
  'Oslo', 'Bergen', 'Trondheim', 'Stavanger', 'Drammen', 'Fredrikstad', 'Kristiansand',
  'Tromsø', 'Sandnes', 'Sarpsborg', 'Skien', 'Bodø', 'Ålesund', 'Tønsberg', 'Arendal',
  'Haugesund', 'Sandefjord', 'Larvik', 'Moss', 'Halden', 'Kongsberg', 'Molde',
  'Harstad', 'Steinkjer', 'Gjøvik', 'Lillehammer', 'Hamar', 'Elverum', 'Brumunddal',
  'Hønefoss', 'Kongsvinger', 'Notodden', 'Porsgrunn', 'Grimstad', 'Mandal', 'Flekkefjord',
  'Egersund', 'Bryne', 'Leirvik', 'Odda', 'Voss', 'Førde', 'Florø', 'Sogndal',
  'Kristiansund', 'Namsos', 'Narvik', 'Sortland', 'Svolvær', 'Leknes', 'Finnsnes',
  'Alta', 'Hammerfest', 'Kirkenes', 'Vadsø', 'Vardø', 'Honningsvåg', 'Kautokeino',
  // Gudbrandsdal
  'Vinstra', 'Otta', 'Dombås', 'Lom', 'Skjåk', 'Vågå', 'Sel', 'Tretten', 'Fåvang',
  'Hundorp', 'Kvam', 'Ringebu', 'Øyer', 'Gausdal', 'Follebu', 'Segalstad bru'
];

// ============================================================
// TIME EXPRESSIONS (commonly misheard)
// ============================================================
const TIME_EXPRESSIONS = [
  'klokka ett', 'klokka to', 'klokka tre', 'klokka fire', 'klokka fem',
  'klokka seks', 'klokka sju', 'klokka åtte', 'klokka ni', 'klokka ti',
  'klokka elleve', 'klokka tolv', 'klokka ett', 'klokka tretten', 'klokka fjorten',
  'klokka femten', 'klokka seksten', 'klokka sytten', 'klokka atten',
  'halv ett', 'halv to', 'halv tre', 'halv fire', 'halv fem', 'halv seks',
  'halv sju', 'halv åtte', 'halv ni', 'halv ti', 'halv elleve', 'halv tolv',
  'kvart over', 'kvart på', 'ti over', 'ti på', 'fem over', 'fem på', 'tjue over', 'tjue på',
  'om morgenen', 'om formiddagen', 'om ettermiddagen', 'om kvelden', 'på kvelden',
  'etter lunsj', 'før lunsj', 'etter jobb', 'etter arbeid', 'tidlig morgen',
  'på dagtid', 'hele dagen', 'når som helst', 'formiddag', 'ettermiddag'
];

// ============================================================
// DATE EXPRESSIONS
// ============================================================
const DATE_EXPRESSIONS = [
  'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag',
  'neste uke', 'denne uken', 'neste mandag', 'neste tirsdag', 'neste onsdag',
  'neste torsdag', 'neste fredag', 'i morgen', 'i overmorgen', 'om to dager',
  'januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august',
  'september', 'oktober', 'november', 'desember',
  'første', 'andre', 'tredje', 'fjerde', 'femte', 'sjette', 'sjuende', 'åttende',
  'niende', 'tiende', 'ellevte', 'tolvte', 'trettende', 'fjortende', 'femtende',
  'sekstende', 'syttende', 'attende', 'nittende', 'tjuende', 'tjueførste',
  'om en uke', 'om to uker', 'om tre uker', 'om en måned'
];

// ============================================================
// DIALECT WORDS (commonly garbled by STT)
// ============================================================
const DIALECT_WORDS = [
  // Gudbrandsdøl
  'æ', 'mæ', 'dæ', 'hær', 'dær', 'itte', 'ikkje', 'noko', 'nokke', 'litte',
  'heimme', 'heime', 'heim', 'golv', 'stolpå', 'dætta', 'hansen', 'sjølv',
  'veit', 'tru', 'trur', 'mykje', 'berre', 'attåt', 'attmed', 'attende',
  'stugu', 'eldhuset', 'fjøset', 'låven', 'stabburet', 'buret', 'selet',
  // Trøndersk
  'kem', 'kor', 'ka', 'ittj', 'itj', 'æ e', 'æ ha', 'æ ska', 'kansen',
  'kosjen', 'førr', 'borrti', 'hansen', 'jansen', 'dokker',
  // Nordlending
  'ho', 'han', 'dæm', 'mæ', 'sæ', 'kansen', 'liksom', 'vettu',
  // Bergensk
  'ka', 'ikkje', 'eg', 'meg', 'deg', 'seg', 'korleis', 'kvifor', 'nokon',
  // Stavangersk
  'eg', 'me', 'de', 'ikkje', 'ka', 'kor', 'kossen',
  // Sørlandsk
  'eg', 'me', 'de', 'ikkje', 'ka', 'kor', 'kå', 'kansen',
  // Telemarksk
  'eg', 'me', 'de', 'ikkje', 'kva', 'kor', 'kossen', 'heite',
  // Østfoldsk
  'je', 'mæ', 'dæ', 'våres', 'dæres', 'hu', 'hanses',
  // Common words that STT mangles
  'gulv', 'gulvlegging', 'gulvsliper', 'gulvbelegg', 'parkett', 'laminat',
  'flislegging', 'maling', 'tapetsering', 'rørlegger', 'elektriker',
  'bestilling', 'bestille', 'avtale', 'time', 'befaring'
];

// ============================================================
// SERVICE-RELATED WORDS
// ============================================================
const SERVICE_WORDS = [
  // Flooring
  'gulv', 'gulvlegging', 'parkett', 'laminat', 'vinyl', 'fliser', 'belegg',
  'gulvsliper', 'gulvsliping', 'teppe', 'gulvvarme', 'underlag', 'terskel',
  // Cleaning
  'rengjøring', 'vask', 'flyttevask', 'hovedrengjøring', 'vinduspuss',
  'tepperens', 'fasadevask', 'byggrengjøring',
  // Kosmetikk
  'behandling', 'ansiktsbehandling', 'hudpleie', 'peeling', 'laser',
  'botox', 'filler', 'microblading', 'vipper', 'bryn', 'negler',
  // Rørlegging
  'rør', 'rørlegger', 'vannlekkasje', 'lekkasje', 'avløp', 'kloakk',
  'toalett', 'servant', 'badekar', 'dusj', 'varmtvannsbereder',
  // Electrician
  'elektriker', 'elektro', 'sikringsskap', 'stikkontakt', 'lys',
  'jordfeilbryter', 'elbillader', 'varmepumpe',
  // Painter
  'maler', 'maling', 'tapetsering', 'tapet', 'sparkling', 'fasade',
  // Antikviteter
  'antikk', 'antikvitet', 'vintage', 'samler', 'brukthandel', 'gjenbruk',
  'lekevogn', 'barnevogn', 'møbler', 'porselein', 'sølvtøy', 'kobbertøy',
  'lampe', 'klokke', 'speil', 'maleri', 'bilde', 'bok', 'dukkevogn',
  // Frisør
  'klipp', 'klipping', 'farge', 'farging', 'striper', 'balayage',
  'permanent', 'føning', 'styling', 'herreklipp', 'dameklipp', 'barneklipp',
  // General
  'befaring', 'tilbud', 'pris', 'garanti', 'reklamasjon', 'faktura', 'betaling'
];

// ============================================================
// NUMBERS (often misheard in addresses/phone)
// ============================================================
const NUMBERS = [
  'null', 'en', 'to', 'tre', 'fire', 'fem', 'seks', 'sju', 'syv', 'åtte', 'ni', 'ti',
  'elleve', 'tolv', 'tretten', 'fjorten', 'femten', 'seksten', 'sytten', 'atten', 'nitten',
  'tjue', 'tretti', 'førti', 'femti', 'seksti', 'sytti', 'åtti', 'nitti', 'hundre',
  'A', 'B', 'C', 'D', 'E', 'F'  // For address suffixes like "13A"
];

// ============================================================
// COMPILE ALL HINTS (max 500 for Twilio)
// ============================================================
function getHints() {
  const all = [
    ...FIRST_NAMES,
    ...SURNAMES,
    ...STREETS,
    ...CITIES,
    ...TIME_EXPRESSIONS,
    ...DATE_EXPRESSIONS,
    ...DIALECT_WORDS,
    ...SERVICE_WORDS,
    ...NUMBERS
  ];
  
  // Deduplicate and take max 500
  const unique = [...new Set(all)];
  const maxHints = 200;
  const hints = unique.slice(0, maxHints);
  
  console.log(`[SPEECH-HINTS] Loaded ${hints.length} hints (from ${unique.length} unique, ${all.length} total)`);
  return hints;
}

// Get hints as comma-separated string for Twilio
function getHintsString() {
  return getHints().join(', ');
}

module.exports = { getHints, getHintsString, FIRST_NAMES, SURNAMES, STREETS, CITIES };

# 🧑‍💻 Coe AI — Komplett Nybegynnar-Guide

> Denne guiden antar at du aldri har programmert før. Kvart steg er forklart i detalj.

---

## 📑 INNHALD

1. [Kva programvare du treng å laste ned](#1-programvare-du-treng)
2. [Korleis filene heng saman](#2-korleis-filene-heng-saman)
3. [Steg-for-steg oppsett](#3-steg-for-steg-oppsett)
4. [Korleis justere AI-samtalar og fikse bugs](#4-justere-ai-samtalar-og-fikse-bugs)
5. [Korleis endre hovudprogrammet + underprogrammer per selskap](#5-hovudprogram-og-underprogrammer)
6. [Kvar API-nøklar skal inn](#6-api-nøklar)
7. [Testing og feilsøking](#7-testing-og-feilsøking)

---

## 1. PROGRAMVARE DU TRENG

Last ned og installer desse (alle er gratis):

### A) Visual Studio Code (VS Code) — Din kodeeditor
- **Kva det er:** Programmet du opnar og redigerer alle filene i
- **Last ned:** [code.visualstudio.com](https://code.visualstudio.com)
- **Vel:** Windows / Mac avhengig av din maskin
- **Installer:** Berre trykk «Next» på alt

### B) Node.js — Køyrer JavaScript-koden din
- **Kva det er:** «Motoren» som faktisk køyrer serveren din
- **Last ned:** [nodejs.org](https://nodejs.org) — vel **LTS-versjonen** (den til venstre)
- **Installer:** Berre trykk «Next» på alt
- **Sjekk at det fungerer:** Opne Terminal (sjå under) og skriv:
  ```
  node --version
  ```
  Du skal sjå noko som `v20.x.x`

### C) Git — Versjonskontroll (valfri men anbefalt)
- **Kva det er:** Held styr på endringar i koden din, og lar deg pushe til nett
- **Last ned:** [git-scm.com](https://git-scm.com)
- **Installer:** Berre trykk «Next» på alt

### D) Terminal / Kommandolinje
- **Windows:** Søk etter «Terminal» eller «PowerShell» i startmenyen
- **Mac:** Opne «Terminal» (ligg i Verktøy/Utilities)
- **I VS Code:** Trykk `` Ctrl+` `` (backtick-tasten) for å opne terminal inne i editoren

### E) ngrok — For å teste lokalt med Twilio
- **Kva det er:** Gjer din lokale server tilgjengeleg frå internett (trengs for testing)
- **Last ned:** [ngrok.com](https://ngrok.com) — lag gratis konto
- **Installer:** Følg instruksjonane på sida

---

## 2. KORLEIS FILENE HENG SAMAN

```
coe-backend/                  ← DETTE ER HEILE PROSJEKTET
│
├── server.js                 ← 🧠 HOVUDPROGRAMMET (hovudfila)
│                                Alt startar her. Denne handterer:
│                                - Twilio-telefonsamtalar
│                                - SMS inn/ut
│                                - API for CRM-dashboardet
│
├── ai-conversation.js        ← 🤖 AI-HJERNEN
│                                Her ligg alle spørsmål og svar.
│                                DU ENDRAR DENNE for å justere
│                                kva AI seier og spør om.
│
├── sms-handler.js            ← 📱 SMS-LOGIKK
│                                Sender meldingar til montør og kunde.
│                                Handterer bilder frå kunde.
│
├── db.js                     ← 💾 DATABASE
│                                Lagrar alle kundar, samtalar, selskap.
│                                Du treng sjeldan endre denne.
│
├── .env.example              ← 🔑 MAL FOR HEMMELEGE NØKLAR
│                                Kopier denne til «.env» og fyll inn
│                                dine Twilio- og OpenAI-nøklar.
│
├── package.json              ← 📦 PAKKELISTE
│                                Fortel Node.js kva bibliotek du treng.
│                                Du treng ikkje endre denne.
│
└── SETUP-GUIDE.md            ← 📖 Teknisk oppsettguide
```

### Visuelt: Korleis alt heng saman

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  KUNDE      │────▶│   TWILIO     │────▶│   server.js     │
│  ringer     │     │  (telefon)   │     │  (hovudprogram)  │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                              ┌─────────────────────┼─────────────────────┐
                              ▼                     ▼                     ▼
                    ┌─────────────────┐   ┌─────────────────┐   ┌──────────────┐
                    │ ai-conversation │   │   sms-handler   │   │     db.js    │
                    │    .js          │   │      .js        │   │  (database)  │
                    │                 │   │                 │   │              │
                    │ "Kva heiter du?"│   │ SMS til montør  │   │ Lagrar alt   │
                    │ "Kvar bur du?"  │   │ SMS til kunde   │   │ om kunden    │
                    └─────────────────┘   └─────────────────┘   └──────────────┘
                              │                     │                     │
                              ▼                     ▼                     ▼
                    ┌─────────────────┐   ┌─────────────────┐   ┌──────────────┐
                    │   OpenAI API    │   │   Twilio SMS    │   │  SQLite DB   │
                    │  (AI-svar)      │   │  (sendingar)    │   │  (lokal fil) │
                    └─────────────────┘   └─────────────────┘   └──────────────┘
```

---

## 3. STEG-FOR-STEG OPPSETT

### STEG 1: Lag prosjektmappe

1. Opne VS Code
2. Trykk `File → Open Folder`
3. Lag ein ny mappe som heiter `coe-backend` på skrivebordet
4. Opne denne mappa

### STEG 2: Legg inn filene

Last ned alle filene frå Tasklet og legg dei i `coe-backend`-mappa:
- `server.js`
- `ai-conversation.js`
- `sms-handler.js`
- `db.js`
- `package.json`
- `.env.example`

**Tips:** I VS Code ser du filene i venstre sidepanel. Klikk på ein fil for å opne den.

### STEG 3: Opprett Twilio-konto

1. Gå til [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
2. Opprett gratis konto (treng e-post + telefonnummer for verifisering)
3. Når du er inne, gå til **Dashboard**
4. **Skriv ned desse** (du finn dei på Dashboard-sida):
   - `Account SID` — ser ut som `AC1234abcd...`
   - `Auth Token` — ser ut som `abcd1234...`
5. Gå til **Phone Numbers → Buy a Number**
   - Vel land: Norway (+47) om tilgjengeleg, elles USA (+1)
   - Huk av for **Voice** og **SMS**
   - Kjøp nummeret (ca $1/mnd)
6. **Skriv ned telefonnummeret** — ser ut som `+4712345678`

### STEG 4: Opprett OpenAI-konto

1. Gå til [platform.openai.com](https://platform.openai.com)
2. Opprett konto eller logg inn
3. Gå til **API Keys** (i menyen til venstre)
4. Trykk **Create new secret key**
5. **Kopier nøkkelen** — ser ut som `sk-abcd1234...`
   - ⚠️ Du ser den berre éin gong! Lagre den trygt.
6. Gå til **Billing** og legg til $10–20 i credits

### STEG 5: Fyll inn .env-fila

1. I VS Code, høgreklikk på `.env.example`
2. Vel **Rename** og endre namnet til `.env`
3. Opne `.env` og fyll inn dine verdiar:

```env
# TWILIO
TWILIO_ACCOUNT_SID=AC1234...din_sid_her
TWILIO_AUTH_TOKEN=abcd1234...din_token_her
TWILIO_PHONE_NUMBER=+4712345678

# OPENAI
OPENAI_API_KEY=sk-abcd1234...din_nøkkel_her

# SERVER
PORT=3000
BASE_URL=https://din-server.com
```

**⚠️ VIKTIG:** `.env`-fila skal ALDRI delast med nokon! Den inneheld hemmelege nøklar.

### STEG 6: Installer dependencies

1. Opne terminal i VS Code (`` Ctrl+` ``)
2. Skriv:
```bash
npm install
```
3. Vent til det er ferdig (kan ta 30 sekund)
4. Du vil sjå ei ny mappe `node_modules/` dukke opp — det er normalt!

### STEG 7: Start serveren lokalt

```bash
npm run dev
```

Du skal sjå:
```
🚀 Coe AI Server running on port 3000
📞 Voice webhook: http://localhost:3000/twilio/voice
💬 SMS webhook: http://localhost:3000/twilio/sms
```

### STEG 8: Test med ngrok

Twilio treng å nå serveren din frå internett. Opne **ein ny terminal** og skriv:

```bash
ngrok http 3000
```

Du får ein URL som `https://abc123.ngrok.io`. Denne er din midlertidige internett-adresse.

### STEG 9: Konfigurer Twilio-webhooks

1. Gå til Twilio Console → **Phone Numbers** → Klikk på ditt nummer
2. Scroll ned til **Voice & Fax**:
   - **A CALL COMES IN:** Lim inn `https://abc123.ngrok.io/twilio/voice`
   - Vel **HTTP POST**
3. Scroll ned til **Messaging**:
   - **A MESSAGE COMES IN:** Lim inn `https://abc123.ngrok.io/twilio/sms`
   - Vel **HTTP POST**
4. Trykk **Save**

### STEG 10: Test det! 🎉

Ring ditt Twilio-nummer frå telefonen din. AI skal svare!

---

## 4. JUSTERE AI-SAMTALAR OG FIKSE BUGS

### Kvar du endrar kva AI seier

**Alt som handlar om kva AI seier og spør ligg i `ai-conversation.js`.**

#### Endre velkomstmeldinga
Opne `ai-conversation.js` og finn denne linja:

```javascript
const SYSTEM_PROMPT = `Du er ein høfleg kundeassistent for {company}...`
```

Endre teksten inni backticks (`` ` ``) til det du vil at AI skal seie.

#### Endre spørsmål per bransje
Finn `INDUSTRY_QUESTIONS` i same fil:

```javascript
const INDUSTRY_QUESTIONS = {
  planke: [
    "Hvilket materiale ønsker du?",
    "Hvor stort areal gjelder det?",
    "Når trenger du levering?"
  ],
  vaskeri: [
    "Hva slags tekstiler ønsker du vasket?",
    ...
  ]
}
```

**For å endre eit spørsmål:** Berre endre teksten i hermeteikn.
**For å legge til eit spørsmål:** Legg til ei ny linje med komma etter.
**For å fjerne eit spørsmål:** Slett linja.

#### Endre korleis AI handterer rare svar
Finn `handleSpontaneousInput` i fila:

```javascript
// Fallback dersom kunden seier noko heilt irrelevant
const FALLBACK_RESPONSES = [
  "Så interessant! Men tilbake til tjenesten vår — ",
  "Spennende! Hva tenker du om oppdraget?",
  "Ja vel! La oss snakke litt om hva du trenger fra oss."
];
```

Legg til fleire svar her for variasjon!

#### Endre tonefall / personlegdom
Finn `SYSTEM_PROMPT` og juster instruksjonane:

```javascript
const SYSTEM_PROMPT = `
Du er ein høfleg kundeassistent.
- Snakk uformelt og vennleg
- Bruk korte setningar
- Ikkje ver for formell
- Dersom kunden spør om pris, sei "Det avhenger av oppdraget, men montøren vår gir deg eit tilbod."
`;
```

### Korleis debugge / feilsøke

#### Sjå kva som skjer i terminalen
Når serveren køyrer, viser den loggar i terminalen:

```
📞 Incoming call from +4798765432
🤖 AI response: "Hei! Kva heiter du?"
📱 SMS sent to montør: +4711111111
```

#### Vanlige feil og løysingar

| Problem | Løysing |
|---------|---------|
| "Cannot find module" | Køyr `npm install` på nytt |
| "TWILIO_ACCOUNT_SID not set" | Sjekk at `.env`-fila er riktig utfylt |
| AI svarer på engelsk | Legg til "Svar alltid på norsk" i `SYSTEM_PROMPT` |
| AI stiller same spørsmål om igjen | Sjekk `conversationState` i `ai-conversation.js` |
| SMS kjem ikkje fram | Sjekk Twilio-loggar på twilio.com → Monitor → Logs |
| Ngrok-URL sluttar å fungere | Start ngrok på nytt, oppdater Twilio-webhooks |

#### Sjå Twilio-loggar
1. Gå til [twilio.com/console](https://www.twilio.com/console)
2. Klikk **Monitor → Logs**
3. Her ser du alle samtalar og SMS med feilmeldingar

---

## 5. HOVUDPROGRAM OG UNDERPROGRAMMER

### Korleis det fungerer no

Hovudprogrammet (`server.js`) kallar AI-hjernen (`ai-conversation.js`) for alle samtalar. 
AI-hjernen har éin felles logikk, men stiller ulike spørsmål basert på bransjen til selskapet.

### Legge til eit nytt selskap

#### Steg 1: Legg til i databasen
Opne terminalen din og køyr:

```bash
# Enten via API:
curl -X POST http://localhost:3000/api/companies \
  -H "Content-Type: application/json" \
  -d '{"name": "Mitt Nye Selskap", "industry": "planke", "phone": "+4799887766", "montour_phone": "+4788776655"}'
```

Eller legg til via CRM-dashboardet (Settings-fanen).

#### Steg 2: Lag eige underprogram for selskapet (valfri)

Om selskapet treng heilt eigen logikk, lag ei ny fil:

1. Lag fila `companies/mitt-selskap.js` i prosjektmappa:

```javascript
// companies/mitt-selskap.js
// Underprogram for Mitt Nye Selskap

module.exports = {
  // Spesifikk velkomsthelsing
  greeting: "Hei og velkommen til Mitt Nye Selskap! Korleis kan eg hjelpe deg?",
  
  // Ekstra spørsmål for dette selskapet
  questions: [
    "Kva type prosjekt gjeld det?",
    "Kor stort areal snakkar vi om?",
    "Har du eit budsjett i tankane?",
    "Når passar det med befaring?"
  ],
  
  // Korleis oppsummere til montør
  formatMontorMessage: (kunde) => {
    return `🔨 NYTT OPPDRAG — Mitt Nye Selskap
Namn: ${kunde.namn}
Telefon: ${kunde.telefon}
Adresse: ${kunde.adresse}
Prosjekt: ${kunde.prosjekt}
Areal: ${kunde.areal}
Budsjett: ${kunde.budsjett}
Ønsket tid: ${kunde.dato}

Svar 1 for å ta oppdraget.`;
  },

  // Spesielle reglar for AI
  aiRules: `
    - Spør alltid om areal i kvadratmeter
    - Anbefal befaring dersom areal er over 50 kvm
    - Ver ekstra høfleg
  `
};
```

2. I `ai-conversation.js`, importer og bruk underprogrammet:

```javascript
// Øvst i fila, legg til:
const mittSelskap = require('./companies/mitt-selskap');

// I getConversationConfig(), legg til:
if (companyName === 'Mitt Nye Selskap') {
  return mittSelskap;
}
```

### Struktur med fleire underprogrammer

```
coe-backend/
├── server.js                  ← Hovudprogram (ikkje endre ofte)
├── ai-conversation.js         ← Felles AI-logikk
├── companies/                 ← 📁 NY MAPPE for underprogrammer
│   ├── planke-as.js           ← Underprogram for Planke AS
│   ├── rent-vaskeri.js        ← Underprogram for Rent Vaskeri
│   ├── glow-kosmetikk.js      ← Underprogram for Glow Kosmetikk
│   └── mitt-selskap.js        ← Underprogram for nytt selskap
├── sms-handler.js
├── db.js
└── ...
```

### Korleis endre felt i heile systemet

#### Legge til eit nytt felt (t.d. «e-post»)

**1. Database (db.js):**
```javascript
// Finn CREATE TABLE customers og legg til:
email TEXT
```

**2. AI-spørsmål (ai-conversation.js):**
```javascript
// Legg til i REQUIRED_FIELDS:
{ field: 'email', question: 'Kva er e-postadressa di?' }
```

**3. SMS til montør (sms-handler.js):**
```javascript
// Legg til i meldingsteksten:
E-post: ${customer.email}
```

**4. CRM Dashboard (app i Tasklet):**
Be meg oppdatere CRM-appen med det nye feltet!

---

## 6. API-NØKLAR — KVAR SKAL KVA

| Nøkkel | Kvar du får den | Kvar den skal |
|--------|----------------|---------------|
| `TWILIO_ACCOUNT_SID` | twilio.com → Dashboard | `.env`-fila |
| `TWILIO_AUTH_TOKEN` | twilio.com → Dashboard | `.env`-fila |
| `TWILIO_PHONE_NUMBER` | twilio.com → Phone Numbers | `.env`-fila |
| `OPENAI_API_KEY` | platform.openai.com → API Keys | `.env`-fila |
| `BASE_URL` | Din server-URL (ngrok eller Railway) | `.env`-fila |

**ALLE nøklar går i `.env`-fila. Ingen andre stader.**

---

## 7. TESTING OG FEILSØKING

### Sjekkliste for testing

- [ ] Serveren startar utan feil (`npm run dev`)
- [ ] Ngrok køyrer og gir deg ein URL
- [ ] Twilio-webhooks peikar til ngrok-URL
- [ ] Ring ditt Twilio-nummer — AI svarer
- [ ] AI stiller spørsmål éin etter éin
- [ ] Etter samtalen: SMS går til montørnummeret
- [ ] Send SMS tilbake med «1» — status oppdaterast
- [ ] Sjekk CRM-dashboardet — kunden viser

### Dagleg workflow

```
1. Opne VS Code
2. Opne terminal (Ctrl+`)
3. Skriv: npm run dev
4. (Opne ny terminal) Skriv: ngrok http 3000
5. Kopier ngrok-URL til Twilio (om den er endra)
6. Test endringar ved å ringe Twilio-nummeret
7. Sjå loggar i terminalen for feilsøking
```

### Når du vil deploye til produksjon (seinare)

Då slepp du ngrok! Bruk Railway i staden:

1. Opprett konto på [railway.app](https://railway.app)
2. Koble til GitHub-kontoen din
3. Push koden til GitHub
4. Railway deployer automatisk
5. Du får ein fast URL (t.d. `coe-backend.up.railway.app`)
6. Oppdater Twilio-webhooks med denne URL-en
7. Ferdig! 🎉

---

## 🆘 VANLIGE SPØRSMÅL

**Q: Eg har endra koden men ingenting skjer?**
A: Restart serveren! Trykk `Ctrl+C` i terminalen, så `npm run dev` på nytt.

**Q: Eg får «Error: listen EADDRINUSE»?**
A: Serveren køyrer allereie. Trykk `Ctrl+C` først, eller bytt port i `.env`.

**Q: Kan eg bruke dette med fleire telefonnummer?**
A: Ja! Kjøp fleire nummer i Twilio og legg dei til som selskap i databasen.

**Q: Kostar det mykje?**
A: Twilio: ca $1/mnd per nummer + $0.01 per minutt. OpenAI: ca $0.01–0.05 per samtale. Railway: gratis → $5/mnd.

**Q: Kan eg endre til ein annan AI enn OpenAI?**
A: Ja, men det krev endringar i `ai-conversation.js`. Eg kan hjelpe med det!

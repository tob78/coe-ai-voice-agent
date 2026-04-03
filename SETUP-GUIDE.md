# 🤖 Coe AI Voice Assistant — Oppsettguide

## Oversikt

Systemet består av:
1. **Backend-server** (Node.js/Express) — Handterer telefonsamtalar, AI-logikk, SMS og CRM API
2. **CRM Dashboard** (React) — Interaktiv admin-app for kundar, status og statistikk
3. **Twilio** — Telefoni og SMS-teneste
4. **OpenAI** — AI-stemme og samtalelogikk

---

## 🔧 Det du må sette opp sjølv

### Steg 1: Twilio-konto

1. **Opprett konto** på [twilio.com](https://www.twilio.com)
2. **Kjøp eit norsk telefonnummer** (+47) under Phone Numbers
3. **Lagre desse verdiane:**
   - Account SID (frå Dashboard)
   - Auth Token (frå Dashboard)
   - Telefonnummeret du kjøpte

4. **Konfigurer webhooks** under telefonnummeret:
   - **Voice & Fax → A CALL COMES IN:** `https://din-server.com/twilio/voice` (HTTP POST)
   - **Messaging → A MESSAGE COMES IN:** `https://din-server.com/twilio/sms` (HTTP POST)

### Steg 2: OpenAI API-nøkkel

1. **Opprett konto** på [platform.openai.com](https://platform.openai.com)
2. **Lag ein API-nøkkel** under API Keys
3. **Legg til credits** (ca $10 for testing, brukar GPT-4o)

### Steg 3: Server (hosting)

Du treng ein server som køyrer Node.js. Alternativ:

| Teneste | Kostnad | Vanskegrad |
|---------|---------|------------|
| **Railway** | Frå $5/mnd | ⭐ Lett |
| **Render** | Gratis → $7/mnd | ⭐ Lett |
| **DigitalOcean** | Frå $5/mnd | ⭐⭐ Medium |
| **Eigen VPS** | Varierer | ⭐⭐⭐ Avansert |

**Anbefaling:** Start med **Railway** eller **Render** — push frå GitHub, ferdig.

### Steg 4: Deploy

```bash
# 1. Klon/kopier filene til ein mappe
cd coe-backend

# 2. Installer dependencies
npm install

# 3. Kopier .env.example til .env og fyll inn verdiane
cp .env.example .env
# Rediger .env med dine verdiar

# 4. Start serveren
npm start
```

### Steg 5: Twilio Webhook-oppsett

Etter serveren køyrer, oppdater Twilio:

1. Gå til Twilio Console → Phone Numbers → Ditt nummer
2. Under **Voice & Fax**:
   - A CALL COMES IN: `https://din-server.com/twilio/voice` (POST)
3. Under **Messaging**:
   - A MESSAGE COMES IN: `https://din-server.com/twilio/sms` (POST)

---

## 📁 Filstruktur

```
coe-backend/
├── server.js          ← Hovudserver med alle routes
├── ai-conversation.js ← AI-samtalelogikk (OpenAI)
├── sms-handler.js     ← SMS til montør/kunde + bildevidaresending
├── db.js              ← SQLite-database og skjema
├── package.json       ← Dependencies
├── .env.example       ← Mal for miljøvariablar
└── SETUP-GUIDE.md     ← Denne fila
```

---

## 🔄 Samtaleflyt

```
Kunde ringer → Twilio → /twilio/voice
                              ↓
                        AI svarer (TTS)
                        Samlar inn: namn, adresse, telefon, dato
                        + bransjespesifikke spørsmål
                              ↓
                        Data komplett?
                        Ja → Lagre i DB → SMS til montør → SMS til kunde (be om bilde)
                        Nei → Spør neste spørsmål (loop)
```

```
Montør svarer SMS → /twilio/sms
                         ↓
                   1 = Oppdrag teke → Status: Booket
                   2 = Pris: XX → Lagre pris
                   3 = Fullført → Status: Fullført
```

```
Kunde sender bilde → /twilio/sms
                           ↓
                     Vidaresendt til montør automatisk
```

---

## 🏭 Bransjelogikk

Systemet støttar ulike bransjar med spesifikke spørsmål:

| Bransje | Ekstra spørsmål |
|---------|----------------|
| **Planke** | Materiale, leveringstid, areal |
| **Vaskeri** | Tekstiltype, mengde, spesielle ønsker |
| **Kosmetikk** | Behandling, hudtype, allergiar |
| **Generell** | Berre basisfelt |

Legg til nye bransjar i `ai-conversation.js` under `INDUSTRY_QUESTIONS`.

---

## 📊 Status-flyt (CRM)

```
Ny → Booket → Sendt til montør → Fullført → Betalt
```

Status oppdaterast automatisk:
- **Ny** → Når kunden registrerast
- **Booket** → Etter fullført AI-samtale
- **Sendt til montør** → Etter SMS er sendt
- **Fullført** → Når montør svarer «3»
- **Betalt** → Manuelt i CRM-dashboardet

---

## 🧪 Testing

1. **Test AI-samtale lokalt:**
   ```bash
   # Start server
   npm run dev
   # Bruk ngrok for å eksponere lokalt
   npx ngrok http 3000
   # Oppdater Twilio webhooks med ngrok-URL
   ```

2. **Ring ditt eige Twilio-nummer** og test samtalen

3. **Test SMS:** Send SMS frå montørnummeret med «1», «2 500», eller «3»

4. **Test bildeopplasting:** Send MMS med bilde frå eit kundenummer

---

## ⚡ Etter MVP — Neste steg

- [ ] Legg til fleire bransjar i `ai-conversation.js`
- [ ] Integrer betaling (Stripe/Vipps)
- [ ] Legg til e-post-varsling
- [ ] Automatisk oppfølging via SMS etter X dagar
- [ ] Dashboard-grafer for konvertering over tid
- [ ] Fleire montørar per selskap med tildelingslogikk
- [ ] Webhook til eksternt CRM (HubSpot, Salesforce)

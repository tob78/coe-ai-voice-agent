// ============================================
// SAMTALE-ANALYSE
// Automatisk gjennomgang av alle samtaler
// Finn feil, forbedringer, og mønstre
// ============================================

const { OpenAI } = require('openai');

class CallAnalyzer {
  constructor(openaiKey) {
    this.openai = new OpenAI({ apiKey: openaiKey });
  }

  // ============================================
  // TRANSKRIBER LYDOPPTAK
  // Twilio gir oss .wav-filer — OpenAI Whisper transkriberer
  // ============================================
  async transcribeRecording(audioUrl) {
    try {
      const response = await fetch(audioUrl);
      const audioBuffer = await response.buffer();
      
      const transcription = await this.openai.audio.transcriptions.create({
        file: audioBuffer,
        model: 'whisper-1',
        language: 'no',
        response_format: 'verbose_json',
      });
      
      return {
        text: transcription.text,
        segments: transcription.segments,
        duration: transcription.duration,
      };
    } catch (error) {
      console.error('Feil ved transkribering:', error);
      return null;
    }
  }

  // ============================================
  // ANALYSER EN SAMTALE
  // Finn problemer, forbedringer, og kvalitet
  // ============================================
  async analyzeSingleCall(transcript, companyName) {
    const analysisPrompt = `Du er en kvalitetsanalytiker for AI-telefonsamtaler.
Analyser denne samtalen mellom en AI-assistent og en kunde for ${companyName}.

SAMTALE:
${transcript}

VIKTIG — LYTT SPESIFIKT ETTER:
1. KUNDEFRUSTRASJON: Bygger irritasjonen seg opp? Ord som "nei!", "det var ikke det jeg sa", "hør her", "jeg sa jo...", sukking, gjentakelser fordi AI ikke forstod
2. AI-MISFORSTÅELSER: Steder der AI hørte feil, tolket feil, eller gjentok noe kunden IKKE sa
3. KUNDEKORREKSJONER: Alle steder kunden retter på AI-en — dette er GULL for selvforbedring
4. TAPT SALG: Signaler der kunden var interessert men AI mistet dem (for treg, for formell, ignorerte spørsmål)
5. AI GJENTOK SEG SELV: Sa AI det samme to ganger? Stilte samme spørsmål igjen?

GI ANALYSE I DETTE JSON-FORMATET:
{
  "kvalitetsscore": 1-10,
  "kundetilfredshet": 1-10,
  "booking_suksess": true/false,
  "problem_kategori": "lekkasje/slitasje/nyinstallasjon/annet",
  "ai_feil": [
    {"type": "dårlig_formulering|manglende_oppfølging|for_formell|misforståelse|for_treg|gjentakelse|ignorerte_spørsmål", "beskrivelse": "...", "forslag": "..."}
  ],
  "gode_ting": ["..."],
  "forbedringsforslag": ["..."],
  "kunde_sentiment": "positiv/nøytral/negativ/frustrert",
  "frustrasjon_eskalering": {
    "startnivå": "rolig/nøytral/litt_irritert",
    "sluttnivå": "fornøyd/nøytral/irritert/sint/la_på",
    "vendepunkt": "Beskriv øyeblikket frustrasjonen økte (eller 'ingen' hvis kunden var fornøyd hele veien)",
    "kundekorreksjoner": ["Direkte sitater der kunden rettet på AI-en"]
  },
  "ai_selvfeil": [
    {"hva_ai_sa": "Direkte sitat fra AI", "hva_kunden_egentlig_sa": "Hva kunden faktisk sa/mente", "konsekvens": "Hva gikk galt pga dette"}
  ],
  "oppfølgingsbehov": {
    "bør_ringes_tilbake": true/false,
    "grunn": "Kunden var frustrert/la på midt i/hadde ubesvarte spørsmål",
    "prioritet": "høy/middels/lav"
  },
  "manglende_informasjon": ["felt som ikke ble samlet"],
  "oppfølging_kvalitet": "god/middels/dårlig",
  "foreslått_endring_i_prompt": "konkret forslag til bedre formulering"
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: analysisPrompt }],
        response_format: { type: 'json_object' },
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.error('Feil ved analyse:', error);
      return null;
    }
  }

  // ============================================
  // BATCH-ANALYSE — gå gjennom mange samtaler
  // ============================================
  async analyzeMultipleCalls(calls) {
    const results = [];
    
    for (const call of calls) {
      // Transkriber hvis vi bare har lyd-URL
      let transcript = call.transcript;
      if (!transcript && call.recordingUrl) {
        const transcription = await this.transcribeRecording(call.recordingUrl);
        transcript = transcription?.text;
      }
      
      if (transcript) {
        const analysis = await this.analyzeSingleCall(transcript, call.companyName);
        results.push({
          callId: call.id,
          companyName: call.companyName,
          timestamp: call.timestamp,
          analysis,
        });
      }
    }
    
    return results;
  }

  // ============================================
  // GENERER FORBEDRINGSRAPPORT
  // Sammenfatning av alle analyser
  // ============================================
  async generateImprovementReport(analyses) {
    const reportPrompt = `Du er en AI-samtaleoptimeringsekspert.
Basert på disse ${analyses.length} samtaleanalysene, lag en forbedringsrapport.

ANALYSER:
${JSON.stringify(analyses, null, 2)}

LAG RAPPORT I DETTE FORMATET:
{
  "sammendrag": "kort oppsummering",
  "gjennomsnittlig_kvalitet": 0.0,
  "gjennomsnittlig_kundetilfredshet": 0.0,
  "booking_rate": "XX%",
  "vanligste_problemer": ["..."],
  "vanligste_ai_feil": [
    {"feil": "...", "frekvens": X, "løsning": "..."}
  ],
  "konkrete_prompt_endringer": [
    {"nåværende": "AI sier nå...", "foreslått": "AI bør heller si...", "grunn": "..."}
  ],
  "nye_oppfølgingsspørsmål_foreslått": [
    {"trigger": "keyword", "spørsmål": "...", "grunn": "..."}
  ],
  "prioritert_handlingsliste": [
    {"prioritet": 1, "handling": "...", "forventet_effekt": "..."}
  ]
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: reportPrompt }],
        response_format: { type: 'json_object' },
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.error('Feil ved rapportgenerering:', error);
      return null;
    }
  }

  // ============================================
  // AUTO-FORBEDRINGSLOOP
  // Les analyser → foreslå endringer → oppdater prompt
  // ============================================
  async autoImprovePrompt(currentPrompt, analyses) {
    const improvementPrompt = `Du er en AI-prompt-optimerer.

NÅVÆRENDE SYSTEM-PROMPT:
${currentPrompt}

BASERT PÅ DISSE PROBLEMENE FRA EKTE SAMTALER:
${analyses.map(a => `- ${a.analysis?.ai_feil?.map(f => f.beskrivelse).join(', ')}`).join('\n')}

SKRIV EN FORBEDRET VERSJON AV SYSTEM-PROMPTEN.
Behold strukturen men fiks de identifiserte problemene.
Gjør AI-en mer naturlig, empatisk, og effektiv.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: improvementPrompt }],
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Feil ved prompt-forbedring:', error);
      return null;
    }
  }
}

module.exports = CallAnalyzer;

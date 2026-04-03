// registry-lookup.js — Verifiserer adresser og stedsnavn mot Kartverket
// Bruker gratis, åpne API-er fra Geonorge (ingen autentisering)
// v1.0.0

const https = require('https');

// Quick HTTPS GET that returns JSON
function fetchJSON(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ============================================================
// 1. Address lookup — Kartverket Adresser API
// ============================================================
async function lookupAddress(rawText) {
  if (!rawText || rawText.length < 3) return null;
  try {
    const q = encodeURIComponent(rawText.trim());
    const url = `https://ws.geonorge.no/adresser/v1/sok?sok=${q}&fuzzy=true&treffPerSide=5`;
    const result = await fetchJSON(url);
    if (!result.adresser || result.adresser.length === 0) return null;
    
    const best = result.adresser[0];
    return {
      verified: true,
      address: best.adressetekst,
      postalCode: best.postnummer,
      city: best.poststed,
      municipality: best.kommunenavn,
      full: `${best.adressetekst}, ${best.postnummer} ${best.poststed}`,
      confidence: result.adresser.length === 1 ? 'high' : 'medium',
      alternatives: result.adresser.slice(1, 4).map(a => ({
        address: a.adressetekst,
        postalCode: a.postnummer,
        city: a.poststed
      }))
    };
  } catch (err) {
    console.error('[REGISTRY] Address lookup error:', err.message);
    return null;
  }
}

// ============================================================
// 2. Place name lookup — Kartverket Stedsnavn API
// ============================================================
async function lookupPlaceName(rawText) {
  if (!rawText || rawText.length < 3) return null;
  try {
    const q = encodeURIComponent(rawText.trim());
    const url = `https://ws.geonorge.no/stedsnavn/v1/navn?sok=${q}&fuzzy=true&treffPerSide=5`;
    const result = await fetchJSON(url);
    if (!result.navn || result.navn.length === 0) return null;
    
    const best = result.navn[0];
    return {
      verified: true,
      name: best.skrivemåte,
      type: best.navneobjekttype,
      municipality: best.kommuner?.[0]?.kommunenavn || '',
      county: best.fylker?.[0]?.fylkesnavn || '',
      alternatives: result.navn.slice(1, 4).map(n => ({
        name: n.skrivemåte,
        type: n.navneobjekttype,
        municipality: n.kommuner?.[0]?.kommunenavn || ''
      }))
    };
  } catch (err) {
    console.error('[REGISTRY] Place name lookup error:', err.message);
    return null;
  }
}

// ============================================================
// 3. Postal code lookup
// ============================================================
async function lookupPostalCode(code) {
  if (!code || !/^\d{4}$/.test(code.trim())) return null;
  try {
    const url = `https://ws.geonorge.no/adresser/v1/sok?postnummer=${code.trim()}&treffPerSide=1`;
    const result = await fetchJSON(url);
    if (!result.adresser || result.adresser.length === 0) return null;
    return {
      postalCode: result.adresser[0].postnummer,
      city: result.adresser[0].poststed,
      municipality: result.adresser[0].kommunenavn
    };
  } catch (err) {
    return null;
  }
}

// ============================================================
// 4. Smart verify — tries address first, then place name
// ============================================================
async function smartVerify(rawText) {
  if (!rawText || rawText.length < 3) return null;
  
  // Run both lookups in parallel for speed
  const [addrResult, placeResult] = await Promise.all([
    lookupAddress(rawText),
    lookupPlaceName(rawText)
  ]);
  
  // Prefer address result if found (more specific)
  if (addrResult) {
    return { type: 'address', ...addrResult };
  }
  if (placeResult) {
    return { type: 'placename', ...placeResult };
  }
  return null;
}

// ============================================================
// 5. Verify and correct customer data
//    Takes raw STT fields, returns corrected versions
// ============================================================
async function verifyCustomerData(customerData) {
  const corrections = {};
  const lookups = [];
  
  // Verify address if present
  if (customerData.address) {
    lookups.push(
      smartVerify(customerData.address).then(result => {
        if (result) {
          corrections.address = {
            original: customerData.address,
            corrected: result.type === 'address' ? result.full : result.name,
            verified: true,
            source: result.type === 'address' ? 'kartverket_adresser' : 'kartverket_stedsnavn',
            details: result
          };
        }
      })
    );
  }
  
  // Verify postal code if present
  if (customerData.postalCode) {
    lookups.push(
      lookupPostalCode(customerData.postalCode).then(result => {
        if (result) {
          corrections.postalCode = {
            original: customerData.postalCode,
            verified: true,
            city: result.city,
            municipality: result.municipality
          };
        }
      })
    );
  }
  
  await Promise.all(lookups);
  return corrections;
}

// ===== BRREG ENHETSREGISTERET API =====
// Free API, no auth needed
async function lookupBrregCompany(orgNumber) {
  try {
    const cleanOrg = orgNumber.toString().replace(/\s/g, '');
    const resp = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter/${cleanOrg}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    
    return {
      name: data.navn,
      org_number: data.organisasjonsnummer,
      org_form: data.organisasjonsform?.beskrivelse || '',
      industry: data.naeringskode1?.beskrivelse || '',
      industry_code: data.naeringskode1?.kode || '',
      address: data.forretningsadresse ? {
        street: (data.forretningsadresse.adresse || []).join(', '),
        postal_code: data.forretningsadresse.postnummer,
        postal_place: data.forretningsadresse.poststed,
        municipality: data.forretningsadresse.kommune,
        country: data.forretningsadresse.land
      } : null,
      website: data.hjemmeside || null,
      employee_count: data.antallAnsatte || 0,
      registered_date: data.registreringsdatoEnhetsregisteret || null,
      active: !data.slettedato
    };
  } catch (err) {
    console.error('❌ Brreg lookup error:', err.message);
    return null;
  }
}

// Search by company name
async function searchBrregCompany(name) {
  try {
    const resp = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(name)}&size=5`);
    if (!resp.ok) return [];
    const data = await resp.json();
    
    return (data._embedded?.enheter || []).map(e => ({
      name: e.navn,
      org_number: e.organisasjonsnummer,
      industry: e.naeringskode1?.beskrivelse || '',
      address: e.forretningsadresse ? 
        `${(e.forretningsadresse.adresse || []).join(', ')}, ${e.forretningsadresse.postnummer} ${e.forretningsadresse.poststed}` : '',
      active: !e.slettedato
    }));
  } catch (err) {
    console.error('❌ Brreg search error:', err.message);
    return [];
  }
}

// ===== GOOGLE MAPS ADDRESS VALIDATION =====
// Uses $200/month free credit (10,000 calls/month)
async function validateAddressGoogleMaps(address, postalCode) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.log('ℹ️ Google Maps API key not set — using Kartverket only');
    return null;
  }
  
  try {
    const query = `${address}, ${postalCode}, Norway`;
    const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}&language=no&region=no`);
    const data = await resp.json();
    
    if (data.status === 'OK' && data.results?.length > 0) {
      const result = data.results[0];
      const components = result.address_components || [];
      
      return {
        formatted_address: result.formatted_address,
        street_number: components.find(c => c.types.includes('street_number'))?.long_name || '',
        street: components.find(c => c.types.includes('route'))?.long_name || '',
        postal_code: components.find(c => c.types.includes('postal_code'))?.long_name || '',
        city: components.find(c => c.types.includes('postal_town'))?.long_name || 
              components.find(c => c.types.includes('locality'))?.long_name || '',
        municipality: components.find(c => c.types.includes('administrative_area_level_2'))?.long_name || '',
        lat: result.geometry?.location?.lat,
        lng: result.geometry?.location?.lng,
        confidence: result.geometry?.location_type || 'APPROXIMATE'
      };
    }
    return null;
  } catch (err) {
    console.error('❌ Google Maps validation error:', err.message);
    return null;
  }
}

module.exports = {
  lookupAddress,
  lookupPlaceName,
  lookupPostalCode,
  smartVerify,
  verifyCustomerData,
  lookupBrregCompany,
  searchBrregCompany,
  validateAddressGoogleMaps
};

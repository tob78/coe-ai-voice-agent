// ===== SMS HANDLER =====
// Handles SMS sending to montør and customer, plus reminders

const twilioClient = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+12602612731';

// ===== SEND ERROR ALERT TO BOSS =====
async function sendErrorAlert(company, callSid, errorMsg, customerPhone) {
  const bossPhone = company?.boss_phone || company?.montour_phone;
  const bossEmail = company?.boss_email;
  
  const alertText = `⚠️ FEIL UNDER SAMTALE ⚠️\n\nSelskap: ${company?.name || 'Ukjent'}\nKunde-tlf: ${customerPhone || 'Ukjent'}\nCall SID: ${callSid || 'Ukjent'}\nFeil: ${errorMsg}\n\nKunden ble IKKE avbrutt — samtalen fortsatte. Men noe gikk galt som bør sjekkes.\n\nSe kunden i CRM — markert med ⚠️`;
  
  // Send SMS alert
  if (bossPhone) {
    await sendSms(bossPhone, alertText);
    console.log(`🚨 Error alert SMS sent to boss: ${bossPhone}`);
  }
  
  // Send email alert if boss_email is set
  if (bossEmail) {
    // Email sent via simple fetch to a webhook or logged for manual follow-up
    console.log(`📧 Error alert for ${bossEmail}: ${errorMsg}`);
  }
  
  return true;
}

// ===== FORMAT PHONE NUMBER =====
function formatPhone(phone) {
  if (!phone) return null;
  let p = phone.toString().replace(/[\s\-\(\)]/g, '');
  // Already E.164 format
  if (p.startsWith('+')) return p;
  // Norwegian 8-digit number
  if (/^\d{8}$/.test(p)) return '+47' + p;
  // Norwegian with 0047 prefix
  if (p.startsWith('0047')) return '+47' + p.slice(4);
  // Norwegian with 47 prefix (10 digits)
  if (p.startsWith('47') && p.length === 10) return '+' + p;
  // Fallback: assume Norwegian
  return '+47' + p.replace(/^0+/, '');
}

// ===== SEND SMS HELPER =====
async function sendSms(to, body) {
  const formattedTo = formatPhone(to);
  if (!formattedTo) {
    console.error('❌ SMS failed: no valid phone number');
    return null;
  }
  try {
    const msg = await twilioClient.messages.create({
      body,
      from: TWILIO_NUMBER,
      to: formattedTo
    });
    console.log(`📱 SMS sent to ${formattedTo}: ${msg.sid}`);
    return msg;
  } catch (err) {
    console.error(`❌ SMS failed to ${formattedTo}:`, err.message);
    // Log more detail for Twilio trial issues
    if (err.code === 21608 || err.code === 21610 || err.code === 21614) {
      console.error('⚠️ TWILIO TRIAL: Nummeret er ikke verifisert i Twilio. Gå til Twilio Console → Verified Caller IDs og legg til nummeret.');
    }
    return null;
  }
}

// ===== EXTRACT CATERING FIELDS FROM NOTES =====
function extractCateringFromNotes(notes) {
  if (!notes) return null;
  const fields = [];
  const guestMatch = notes.match(/(\d+)\s*gjester/i);
  if (guestMatch) fields.push(`👥 Gjester: ${guestMatch[1]}`);
  const typeMatch = notes.match(/(konfirmasjon|bryllup|begravelse|bursdag|julebord|firmafest|arrangement|dåp|minnestund)/i);
  if (typeMatch) fields.push(`🎉 Type: ${typeMatch[1]}`);
  const deliveryMatch = notes.match(/(utkjøring|levering|henting|henter)/i);
  if (deliveryMatch) fields.push(`🚗 ${deliveryMatch[1].charAt(0).toUpperCase() + deliveryMatch[1].slice(1)}`);
  return fields.length > 0 ? fields.join('\n') : null;
}

// ===== SEND TO MONTØR =====
async function sendToMontour(customer, company, booking) {
  if (company.sms_notify_worker === false) {
    console.log('ℹ️ SMS-varsling til ansatt er deaktivert for', company.name);
    return null;
  }
  if (!company.montour_phone) {
    console.log('⚠️ No montør phone for company', company.name);
    return null;
  }

  // Use booking data if available, fallback to customer
  const name = booking?.customer_name || customer.name || 'Ukjent';
  const phone = customer.phone || 'Ikke oppgitt';
  const address = booking?.address || customer.address || 'Ikke oppgitt';
  const postalCode = customer.postal_code || '';
  const service = booking?.service_request || customer.service_requested || 'Ikke spesifisert';
  const date = booking?.date_requested || customer.preferred_date || '';
  const time = booking?.time_requested || customer.preferred_time || '';
  const notes = booking?.notes || customer.comment || '';
  const wantedEmployee = booking?.ønsket_ansatt || customer.ønsket_ansatt || '';

  // Format availability from booking or customer
  let availText = '';
  if (date) {
    availText = `📅 Dato: ${date}`;
    if (time) availText += `\n⏰ Tid: ${time}`;
    else availText += '\n⏰ Tid: Ikke spesifisert';
  } else {
    availText = formatAvailabilityForSms(customer);
  }

  // Build SMS body with all relevant info
  let body = `📞 Ny kunde venter! — ${company.name}
Kunde: ${name}
Tlf: ${phone}
Tjeneste: ${service}`;

  if (address && address !== 'Ikke oppgitt') {
    body += `\nAdresse: ${address}${postalCode ? ' (' + postalCode + ')' : ''}`;
  }

  body += `\n${availText}`;

  if (wantedEmployee) body += `\nØnsket ansatt: ${wantedEmployee}`;
  if (notes) body += `\nNotat: ${notes}`;

  // Catering-specific fields
  if (booking?.notes) {
    const cateringFields = extractCateringFromNotes(booking.notes);
    if (cateringFields) body += `\n${cateringFields}`;
  }

  body += `\n\nSvar: 1=Tar oppdraget, 2=Pris(f.eks 2 5000), 3=Fullført`;

  return sendSms(company.montour_phone, body.trim());
}

// ===== SEND BESTILLINGSBEKREFTELSE TIL KUNDEN =====
async function sendBookingConfirmation(customer, company, booking) {
  if (company.sms_confirm_customer === false) {
    console.log('ℹ️ Bekreftelse-SMS til kunde er deaktivert for', company.name);
    return null;
  }
  if (!customer.phone) {
    console.log('⚠️ No customer phone — skipping confirmation SMS');
    return null;
  }

  const name = booking?.customer_name || customer.name || '';
  const service = booking?.service_request || customer.service_requested || '';
  const address = booking?.address || customer.address || '';
  const date = booking?.date_requested || customer.preferred_date || '';
  const time = booking?.time_requested || customer.preferred_time || '';

  let body = `Hei${name ? ' ' + name : ''}! ✅ Din bestilling hos ${company.name} er bekreftet.`;
  if (service) body += `\nTjeneste: ${service}`;
  if (date) body += `\n📅 Dato: ${date}`;
  if (time) body += `\n⏰ Tid: ${time}`;
  if (address) body += `\n📍 Adresse: ${address}`;
  body += `\n\nHar du spørsmål? Ring oss gjerne. Ha en fin dag! 😊`;

  return sendSms(customer.phone, body.trim());
}

// ===== FORMAT AVAILABILITY FOR SMS =====
function formatAvailabilityForSms(customer) {
  // Try structured availability_json first
  let slots = [];
  try {
    slots = JSON.parse(customer.availability_json || '[]');
  } catch(e) {}

  if (slots.length > 0) {
    const lines = slots.map(slot => {
      const excluded = getExcludedDates(customer);
      let text = '';
      if (slot.end && slot.start !== slot.end) {
        text = `📅 ${formatDate(slot.start)} — ${formatDate(slot.end)}`;
      } else {
        text = `📅 ${formatDate(slot.start)}`;
      }
      if (slot.time) text += ` kl ${slot.time}`;
      if (slot.allDay) text += ' (hele dagen)';
      
      // Show excluded dates for this range
      const rangeExcluded = excluded.filter(d => {
        const dt = new Date(d);
        return dt >= new Date(slot.start) && dt <= new Date(slot.end || slot.start);
      });
      if (rangeExcluded.length > 0) {
        text += `\n   ❌ Ikke: ${rangeExcluded.map(formatDate).join(', ')}`;
      }
      return text;
    });
    return lines.join('\n');
  }

  // Fallback to old fields
  let text = '';
  if (customer.preferred_date) {
    text = `📅 Dato: ${customer.preferred_date}`;
    if (customer.preferred_date_end) text += ` — ${customer.preferred_date_end}`;
  }
  if (customer.preferred_time) {
    text += `\n⏰ Tid: ${customer.preferred_time}`;
  }
  return text || '📅 Tid: Ikke spesifisert';
}

// ===== DATE HELPERS =====
function formatDate(dateStr) {
  if (!dateStr) return 'ukjent';
  const months = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getDate()}. ${months[d.getMonth()]}`;
}

function getExcludedDates(customer) {
  try {
    return JSON.parse(customer.excluded_dates || '[]');
  } catch(e) { return []; }
}

// ===== PARSE AVAILABILITY FROM AI TEXT =====
// Parses things like "7-14 september, 8 oktober, 9-17 oktober kl 10:00, 8 desember"
function parseAvailabilityText(text) {
  if (!text) return [];
  
  const months = {
    'januar': 0, 'jan': 0,
    'februar': 1, 'feb': 1,
    'mars': 2, 'mar': 2,
    'april': 3, 'apr': 3,
    'mai': 4,
    'juni': 5, 'jun': 5,
    'juli': 6, 'jul': 6,
    'august': 7, 'aug': 7,
    'september': 8, 'sep': 8, 'sept': 8,
    'oktober': 9, 'okt': 9,
    'november': 10, 'nov': 10,
    'desember': 11, 'des': 11
  };

  const slots = [];
  const year = new Date().getFullYear();
  
  // Split by comma or "og"
  const parts = text.split(/[,]|\s+og\s+/).map(s => s.trim()).filter(Boolean);
  
  for (const part of parts) {
    let time = null;
    let allDay = false;
    let cleanPart = part;
    
    // Extract time (kl/klokken)
    const timeMatch = cleanPart.match(/kl(?:okken)?\s*(\d{1,2}[:.]\d{2}(?:\s*-\s*\d{1,2}[:.]\d{2})?)/i);
    if (timeMatch) {
      time = timeMatch[1].replace('.', ':');
      cleanPart = cleanPart.replace(timeMatch[0], '').trim();
    }
    
    // Check "hele dagen"
    if (/hele\s*dagen/i.test(cleanPart)) {
      allDay = true;
      cleanPart = cleanPart.replace(/hele\s*dagen/i, '').trim();
    }
    
    // Find month
    let monthNum = -1;
    let monthWord = '';
    for (const [name, num] of Object.entries(months)) {
      if (cleanPart.toLowerCase().includes(name)) {
        monthNum = num;
        monthWord = name;
        break;
      }
    }
    
    if (monthNum === -1) continue; // Skip if no month found
    
    // Remove month from string to find dates
    const datePartStr = cleanPart.toLowerCase().replace(monthWord, '').replace(/\./g, '').trim();
    
    // Check for range (7-14, 7 - 14, 7. - 14.)
    const rangeMatch = datePartStr.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
    if (rangeMatch) {
      const startDay = parseInt(rangeMatch[1]);
      const endDay = parseInt(rangeMatch[2]);
      const startDate = new Date(year, monthNum, startDay);
      const endDate = new Date(year, monthNum, endDay);
      // If date is in the past, use next year
      if (endDate < new Date()) {
        startDate.setFullYear(year + 1);
        endDate.setFullYear(year + 1);
      }
      slots.push({
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
        time: time || null,
        allDay: !time && !allDay ? true : allDay
      });
    } else {
      // Single date
      const dayMatch = datePartStr.match(/(\d{1,2})/);
      if (dayMatch) {
        const day = parseInt(dayMatch[1]);
        const date = new Date(year, monthNum, day);
        if (date < new Date()) date.setFullYear(year + 1);
        slots.push({
          start: date.toISOString().split('T')[0],
          end: date.toISOString().split('T')[0],
          time: time || null,
          allDay: !time && !allDay ? true : allDay
        });
      }
    }
  }
  
  return slots;
}

// ===== SEND REMINDER SMS =====
async function sendReminderSms(customer, company, slot) {
  if (company.sms_remind_customer === false) {
    console.log('ℹ️ Påminnelse-SMS til kunde er deaktivert for', company.name);
    return null;
  }
  if (!customer.phone) return null;

  let dateText = formatDate(slot.start);
  if (slot.end && slot.start !== slot.end) {
    dateText = `${formatDate(slot.start)} — ${formatDate(slot.end)}`;
  }
  let timeText = slot.time ? `kl ${slot.time}` : 'hele dagen';

  const body = `⏰ Påminnelse fra ${company.name}
Hei ${customer.name || ''}! Du har en avtale ${dateText} (${timeText}).
${customer.service_requested ? 'Tjeneste: ' + customer.service_requested : ''}
Har du spørsmål? Ring oss eller svar på denne meldingen. Vi gleder oss! 😊`;

  return sendSms(customer.phone, body.trim());
}

// ===== REMINDER SCHEDULER =====
// Runs every 15 minutes, checks for upcoming appointments
function startReminderScheduler(db) {
  console.log('⏰ Reminder scheduler started (checks every 15 min)');
  
  setInterval(async () => {
    try {
      await checkAndSendReminders(db);
    } catch (err) {
      console.error('❌ Reminder scheduler error:', err.message);
    }
  }, 15 * 60 * 1000); // Every 15 minutes

  // Also run once at startup after a short delay
  setTimeout(() => checkAndSendReminders(db).catch(e => console.error('❌ Initial reminder check error:', e.message)), 30000);
}

async function checkAndSendReminders(db) {
  const now = new Date();
  
  // ===== NEW: Read from BOOKINGS table (primary source of dates) =====
  const bookings = await db.all(`
    SELECT b.id as booking_id, b.preferred_date, b.preferred_time, b.confirmation_status,
           b.notes, c.id as customer_id, c.name, c.phone, c.reminder_sent,
           comp.name as company_name, comp.montour_phone, comp.sms_remind_customer
    FROM bookings b
    JOIN customers c ON b.customer_id = c.id
    JOIN companies comp ON b.company_id = comp.id
    WHERE b.preferred_date IS NOT NULL
    AND c.phone IS NOT NULL AND c.phone != ''
    AND comp.sms_remind_customer != false
  `);

  for (const booking of bookings) {
    const company = { name: booking.company_name, montour_phone: booking.montour_phone };
    let remindersSent = [];
    try { remindersSent = JSON.parse(booking.reminder_sent || '[]'); } catch(e) {}

    // Parse date — skip non-YYYY-MM-DD dates like "torsdag"
    const startDate = new Date(booking.preferred_date);
    if (isNaN(startDate.getTime())) continue;
    
    const reminderKey = `booking_${booking.booking_id}`;
    if (remindersSent.includes(reminderKey)) continue; // Already sent

    let shouldSend = false;
    const timeStr = booking.preferred_time || '';
    const isAllDay = !timeStr || timeStr.toLowerCase().includes('hele') || timeStr.toLowerCase().includes('hel dag');
    
    // Parse time from various formats: "14:00", "14-16", "kl 14", "Hele dagen"
    const timeMatch = timeStr.match(/(\d{1,2})[:.h]?(\d{2})?/);
    const hour = timeMatch ? parseInt(timeMatch[1]) : null;
    const minute = timeMatch ? parseInt(timeMatch[2] || '0') : 0;

    if (!isAllDay && hour !== null) {
      // Specific time — send 2 hours before
      const appointmentTime = new Date(startDate);
      appointmentTime.setHours(hour, minute, 0, 0);
      const twoHoursBefore = new Date(appointmentTime.getTime() - 2 * 60 * 60 * 1000);
      
      if (now >= twoHoursBefore && now < appointmentTime) {
        shouldSend = true;
      }
      
      // Also send day before at 18:00 if appointment is early (before 10:00)
      if (hour < 10) {
        const dayBefore = new Date(startDate);
        dayBefore.setDate(dayBefore.getDate() - 1);
        dayBefore.setHours(18, 0, 0, 0);
        const endWindow = new Date(dayBefore);
        endWindow.setHours(23, 59, 59, 999);
        if (now >= dayBefore && now <= endWindow) { shouldSend = true; }
      }
    } else {
      // Hele dagen or no time — send day before at 18:00
      const dayBefore = new Date(startDate);
      dayBefore.setDate(dayBefore.getDate() - 1);
      dayBefore.setHours(18, 0, 0, 0);
      const endWindow = new Date(dayBefore);
      endWindow.setHours(23, 59, 59, 999);
      if (now >= dayBefore && now <= endWindow) { shouldSend = true; }
    }

    if (shouldSend) {
      console.log(`⏰ Sending reminder to ${booking.name} for booking ${booking.booking_id} on ${booking.preferred_date}`);
      const customer = { name: booking.name, phone: booking.phone, preferred_date: booking.preferred_date, preferred_time: booking.preferred_time };
      const slot = { start: booking.preferred_date, time: booking.preferred_time, allDay: isAllDay };
      await sendReminderSms(customer, company, slot);
      remindersSent.push(reminderKey);
      
      // Update reminder_sent on customer
      await db.run(
        'UPDATE customers SET reminder_sent = $1 WHERE id = $2',
        JSON.stringify(remindersSent), booking.customer_id
      );
    }
  }
  
  // ===== LEGACY: Also check customers table for old data =====
  const customers = await db.all(`
    SELECT c.*, comp.name as company_name, comp.montour_phone
    FROM customers c
    JOIN companies comp ON c.company_id = comp.id
    WHERE c.status IN ('Booket', 'Ny', 'Inngått avtale')
    AND c.phone IS NOT NULL AND c.phone != ''
    AND c.preferred_date IS NOT NULL
    AND comp.sms_remind_customer != false
  `);

  for (const customer of customers) {
    const company = { name: customer.company_name, montour_phone: customer.montour_phone };
    let remindersSent = [];
    try { remindersSent = JSON.parse(customer.reminder_sent || '[]'); } catch(e) {}

    const startDate = new Date(customer.preferred_date);
    if (isNaN(startDate.getTime())) continue;
    
    const reminderKey = `customer_${customer.id}_${customer.preferred_date}`;
    if (remindersSent.includes(reminderKey)) continue;

    const isAllDay = !customer.preferred_time || customer.preferred_time.toLowerCase().includes('hele');
    let shouldSend = false;
    
    if (!isAllDay && customer.preferred_time) {
      const timeMatch = customer.preferred_time.match(/(\d{1,2})[:.h]?(\d{2})?/);
      if (timeMatch) {
        const appointmentTime = new Date(startDate);
        appointmentTime.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2] || '0'), 0, 0);
        const twoHoursBefore = new Date(appointmentTime.getTime() - 2 * 60 * 60 * 1000);
        if (now >= twoHoursBefore && now < appointmentTime) { shouldSend = true; }
      }
    } else {
      const dayBefore = new Date(startDate);
      dayBefore.setDate(dayBefore.getDate() - 1);
      dayBefore.setHours(18, 0, 0, 0);
      const endWindow = new Date(dayBefore);
      endWindow.setHours(23, 59, 59, 999);
      if (now >= dayBefore && now <= endWindow) { shouldSend = true; }
    }

    if (shouldSend) {
      console.log(`⏰ Legacy reminder to ${customer.name} for ${customer.preferred_date}`);
      const slot = { start: customer.preferred_date, time: customer.preferred_time, allDay: isAllDay };
      await sendReminderSms(customer, company, slot);
      remindersSent.push(reminderKey);
      await db.run('UPDATE customers SET reminder_sent = $1 WHERE id = $2', JSON.stringify(remindersSent), customer.id);
    }
  }
}

// ===== HANDLE INCOMING SMS =====
async function handleIncomingSms(from, body, db) {
  console.log(`📨 Incoming SMS from ${from}: ${body}`);
  
  // Check if it's from a montør
  const company = await db.get(
    "SELECT * FROM companies WHERE montour_phone = $1",
    from
  );
  
  if (!company) {
    console.log('📨 SMS from unknown number:', from);
    return;
  }

  const trimmed = body.trim();
  
  // Get latest booked customer for this company
  const customer = await db.get(
    "SELECT * FROM customers WHERE company_id = $1 AND status = 'Booket' ORDER BY created_at DESC LIMIT 1",
    company.id
  );

  if (!customer) {
    console.log('📨 No booked customer found for company', company.name);
    return;
  }

  // 1 = Accept job
  if (trimmed === '1') {
    console.log(`✅ Montør accepted job for ${customer.name}`);
    await sendSms(from, `👍 Du har tatt oppdraget for ${customer.name}. Lykke til!`);
  }
  // 2 + price = Set price
  else if (trimmed.startsWith('2')) {
    const priceMatch = trimmed.match(/2\s+(\d+)/);
    if (priceMatch) {
      const price = parseInt(priceMatch[1]);
      await db.run('UPDATE customers SET price = $1 WHERE id = $2', price, customer.id);
      console.log(`💰 Price set: ${price} for ${customer.name}`);
      await sendSms(from, `💰 Pris ${price} kr registrert for ${customer.name}.`);
    }
  }
  // 3 = Completed
  else if (trimmed === '3') {
    await db.run("UPDATE customers SET status = 'Fullført' WHERE id = $1", customer.id);
    console.log(`✅ Job completed for ${customer.name}`);
    await sendSms(from, `✅ Oppdrag for ${customer.name} er registrert som fullført!`);
  }
}

// ===== SEND EXTRACTION SMS (AI-UTTREKK FRA SAMTALE) =====
// Extracts key info from transcript using GPT and sends summary to montør/eier
async function sendExtractionSms(transcript, customer, company, booking) {
  if (company.sms_extract_employee === false) {
    console.log('ℹ️ Uttrekk-SMS til ansatt er deaktivert for', company.name);
    return null;
  }
  if (!company.montour_phone || !transcript) return null;
  
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        { role: 'system', content: `Du er en assistent som trekker ut det viktigste fra en telefonsamtale. Skriv KORT oppsummering (maks 5 kulepunkter) på norsk bokmål. Fokuser på:
- Hva kunden trenger/problemet
- Spesielle ønsker eller hensyn
- Haster det?
- Eventuell prisforventning
- Annet viktig
Skriv BARE kulepunktene, ingen intro.` },
        { role: 'user', content: `Transkripsjon:\n${transcript}` }
      ]
    });
    
    const summary = extraction.choices[0]?.message?.content?.trim();
    if (!summary) return null;
    
    let bookingInfo = '';
    if (booking) {
      const parts = [];
      if (booking.service_request) parts.push(`Tjeneste: ${booking.service_request}`);
      if (booking.date_requested) parts.push(`📅 Dato: ${booking.date_requested}`);
      if (booking.time_requested) parts.push(`⏰ Tid: ${booking.time_requested}`);
      if (booking.address) parts.push(`📍 Adresse: ${booking.address}`);
      bookingInfo = parts.length > 0 ? '\n' + parts.join('\n') : '';
    }
    
    const smsBody = `📞 Ny kunde venter! — ${company.name}
Kunde: ${customer?.name || 'Ukjent'}
Tlf: ${customer?.phone || '–'}
${bookingInfo}

${summary}

Se full samtale i CRM.`;
    
    await sendSms(company.montour_phone, smsBody.trim());
    console.log(`🔍 Extraction SMS sent to ${company.montour_phone}`);
    return summary;
  } catch (err) {
    console.error('⚠️ Extraction SMS failed:', err.message);
    return null;
  }
}

// ===== FORWARD IMAGE TO MONTØR =====
async function forwardImageToMontour(customer, company, imageUrl) {
  if (!company.montour_phone) return null;
  
  try {
    const msg = await twilioClient.messages.create({
      body: `📸 Bilde fra ${customer.name || 'kunde'}:`,
      from: TWILIO_NUMBER,
      to: company.montour_phone,
      mediaUrl: [imageUrl]
    });
    console.log(`📸 Image forwarded to montør: ${msg.sid}`);
    return msg;
  } catch (err) {
    console.error('❌ Forward image failed:', err.message);
    return null;
  }
}

module.exports = {
  sendSms,
  sendToMontour,
  sendToCustomer: sendBookingConfirmation, // Alias for backwards compat
  sendBookingConfirmation,
  sendReminderSms,
  handleIncomingSms,
  forwardImageToMontour,
  sendExtractionSms,
  startReminderScheduler,
  parseAvailabilityText,
  formatAvailabilityForSms,
  getExcludedDates,
  sendErrorAlert,
  formatPhone,
  extractCateringFromNotes
};

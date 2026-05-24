/* GMEET_v1 — meeting create / list / cancel APIs.
   Backs the Lead-modal "📅 Schedule meeting" button. Creates Google Calendar
   events with auto-generated Google Meet links, optionally sends the link to
   the lead via WhatsApp (within the 24h conversation window).
*/
const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const gcal = require('./googleCalendar');

async function _ensureTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS lead_meetings (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    google_event_id TEXT,
    meet_link TEXT,
    calendar_id TEXT DEFAULT 'primary',
    status TEXT NOT NULL DEFAULT 'scheduled',
    wa_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  try { await db.query('CREATE INDEX IF NOT EXISTS idx_lead_meetings_lead ON lead_meetings(lead_id)'); } catch (_) {}
  try { await db.query('CREATE INDEX IF NOT EXISTS idx_lead_meetings_start ON lead_meetings(start_at)'); } catch (_) {}
}

/* Create a meeting: Google Calendar event (with Meet link) + DB row +
   optional WhatsApp send. */
async function api_meetings_create(token, payload) {
  const me = await authUser(token);
  await _ensureTable();
  const p = payload || {};
  const leadId = Number(p.lead_id);
  if (!leadId) throw new Error('lead_id required');

  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');

  const title = String(p.title || ('Meeting with ' + (lead.name || 'lead'))).slice(0, 200);
  const desc  = String(p.description || '').slice(0, 2000);
  const startAt = new Date(p.start_at);
  if (isNaN(startAt.getTime())) throw new Error('Invalid start_at (use ISO datetime, e.g. 2026-05-25T15:00:00+05:30)');
  const durationMinutes = Math.max(5, Math.min(480, Number(p.duration_minutes) || 30));
  const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);

  const accessToken = await gcal._getValidAccessToken(me.id);

  const attendees = [];
  if (lead.email && /^\S+@\S+\.\S+$/.test(lead.email)) {
    attendees.push({ email: lead.email, displayName: lead.name || '' });
  }
  const eventBody = {
    summary: title,
    description: desc + (lead.phone ? '\n\nLead: ' + (lead.name || '') + ' (' + lead.phone + ')' : ''),
    start: { dateTime: startAt.toISOString(), timeZone: 'Asia/Kolkata' },
    end:   { dateTime: endAt.toISOString(),   timeZone: 'Asia/Kolkata' },
    attendees,
    conferenceData: {
      createRequest: {
        requestId: 'crm-' + me.id + '-' + Date.now(),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    reminders: { useDefault: true }
  };

  const cr = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=' + (attendees.length ? 'all' : 'none'), {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody)
  });
  const data = await cr.json();
  if (data.error) throw new Error('Google Calendar: ' + (data.error.message || JSON.stringify(data.error)));

  const meetLink =
    (data.conferenceData && data.conferenceData.entryPoints && data.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video')?.uri)
    || data.hangoutLink
    || '';

  const meetingId = await db.insert('lead_meetings', {
    lead_id: leadId, user_id: me.id,
    title, description: desc,
    start_at: startAt.toISOString(), end_at: endAt.toISOString(),
    google_event_id: data.id, meet_link: meetLink,
    calendar_id: 'primary', status: 'scheduled'
  });

  /* Optional WhatsApp send — best-effort. Uses api_wb_chat_send which
     works only inside the 24-hour WhatsApp conversation window. Outside
     that window the send will fail; we surface the error but the meeting
     is still saved + the Google Meet event was created. */
  let waSent = false, waError = null;
  if (p.send_wa && (lead.whatsapp || lead.phone)) {
    try {
      const phone = String(lead.whatsapp || lead.phone || '').replace(/\D/g, '');
      const istTime = startAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      const msg = '📅 *Meeting Scheduled*\n\n' +
                  '*' + title + '*\n' +
                  '🕐 ' + istTime + ' IST\n' +
                  '⏱ ' + durationMinutes + ' minutes\n\n' +
                  '🔗 Join: ' + meetLink +
                  (desc ? '\n\n' + desc : '') +
                  '\n\nSee you then!';
      const wb = require('./whatsbot');
      await wb.api_wb_chat_send(token, { phone, lead_id: leadId, text: msg });
      waSent = true;
      await db.query('UPDATE lead_meetings SET wa_sent_at = NOW() WHERE id = $1', [meetingId]);
    } catch (e) { waError = e.message; }
  }

  return {
    ok: true,
    meeting_id: meetingId,
    meet_link: meetLink,
    google_event_id: data.id,
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
    duration_minutes: durationMinutes,
    wa_sent: waSent,
    wa_error: waError,
    wa_attempted: !!p.send_wa
  };
}

/* List all meetings for a lead (newest start_at first). */
async function api_meetings_list(token, leadId) {
  await authUser(token);
  await _ensureTable();
  const lid = Number(leadId);
  if (!lid) return [];
  const { rows } = await db.query(
    `SELECT m.id, m.lead_id, m.user_id, m.title, m.description,
            m.start_at, m.end_at, m.google_event_id, m.meet_link,
            m.status, m.wa_sent_at, m.created_at,
            u.name AS user_name
       FROM lead_meetings m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.lead_id = $1
      ORDER BY m.start_at DESC
      LIMIT 50`,
    [lid]
  );
  return rows;
}

/* Cancel a meeting: delete the Google Calendar event (best-effort) +
   mark DB row status='cancelled'. */
async function api_meetings_cancel(token, meetingId) {
  const me = await authUser(token);
  const id = Number(meetingId);
  if (!id) throw new Error('meeting_id required');
  const row = await db.findById('lead_meetings', id);
  if (!row) throw new Error('Meeting not found');
  if (row.status === 'cancelled') return { ok: true, already_cancelled: true };
  if (me.role !== 'admin' && Number(row.user_id) !== Number(me.id)) {
    throw new Error('Only the meeting creator (or an admin) can cancel');
  }

  if (row.google_event_id) {
    try {
      const accessToken = await gcal._getValidAccessToken(row.user_id);
      await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/' +
          encodeURIComponent(row.google_event_id) + '?sendUpdates=all',
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + accessToken } }
      );
    } catch (e) { console.warn('[meetings] google cancel failed:', e.message); }
  }
  await db.query('UPDATE lead_meetings SET status = $1, updated_at = NOW() WHERE id = $2', ['cancelled', id]);
  return { ok: true };
}

/* Resend the Meet link to the lead via WhatsApp (best-effort). */
async function api_meetings_resendWa(token, meetingId) {
  const me = await authUser(token);
  const row = await db.findById('lead_meetings', Number(meetingId));
  if (!row) throw new Error('Meeting not found');
  if (row.status === 'cancelled') throw new Error('Meeting is cancelled');
  const lead = await db.findById('leads', row.lead_id);
  if (!lead || !(lead.whatsapp || lead.phone)) throw new Error('Lead has no WhatsApp / phone');

  const phone = String(lead.whatsapp || lead.phone || '').replace(/\D/g, '');
  const startAt = new Date(row.start_at);
  const istTime = startAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const durationMinutes = Math.round((new Date(row.end_at).getTime() - startAt.getTime()) / 60000);
  const msg = '📅 *Meeting Reminder*\n\n' +
              '*' + row.title + '*\n' +
              '🕐 ' + istTime + ' IST\n' +
              '⏱ ' + durationMinutes + ' minutes\n\n' +
              '🔗 Join: ' + row.meet_link;
  const wb = require('./whatsbot');
  await wb.api_wb_chat_send(token, { phone, lead_id: row.lead_id, text: msg });
  await db.query('UPDATE lead_meetings SET wa_sent_at = NOW() WHERE id = $1', [row.id]);
  return { ok: true };
}

module.exports = {
  api_meetings_create, api_meetings_list, api_meetings_cancel, api_meetings_resendWa
};

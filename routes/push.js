/**
 * routes/push.js — Web Push notifications via the standard W3C Push API.
 *
 * Gives the CRM SMS-style notifications: the user's phone shows a banner
 * + plays the OS sound + vibrates EVEN WHEN THE APP IS CLOSED, as long as
 * the browser/PWA is installed and has been granted notification permission.
 *
 * Mechanism:
 *   1. On boot the server ensures a VAPID keypair exists. Read from env
 *      (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) if present, otherwise
 *      generate-and-persist into the `config` table on first boot. The
 *      same keypair is used for the lifetime of the deployment so existing
 *      subscriptions stay valid.
 *   2. Frontend pulls the public key via api_push_publicKey, asks the
 *      browser to register a Push Manager subscription, and sends the
 *      resulting subscription object back via api_push_subscribe — we
 *      store {user_id, endpoint, p256dh, auth} in the push_subscriptions
 *      table.
 *   3. When the server has news for a user (new lead assigned, follow-up
 *      reminder due) it calls sendPushToUser(userId, payload), which
 *      iterates that user's subscriptions and POSTs to the browser's push
 *      endpoint.
 *
 * If web-push isn't installed (e.g. local dev forgot npm install) the
 * helpers all silently no-op — they never throw.
 */

let webpush = null;
try { webpush = require('web-push'); }
catch (e) { console.warn('[push] web-push not installed yet — push notifications disabled'); }

// firebase-admin sends FCM messages to the Capacitor Android app. Loaded
// lazily so the server still boots even if the package isn't installed yet.
let admin = null;
let _fcmReady = false;
try { admin = require('firebase-admin'); }
catch (e) { console.warn('[push] firebase-admin not installed — FCM disabled'); }

function _initFcm() {
  if (_fcmReady || !admin) return _fcmReady;
  // Two ways to supply the service account JSON:
  //   1. FIREBASE_SERVICE_ACCOUNT_JSON  — entire JSON pasted into one env var
  //   2. GOOGLE_APPLICATION_CREDENTIALS — path to the JSON on disk (fallback)
  let creds = null;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try { creds = JSON.parse(raw); }
    catch (e) { console.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON not valid JSON:', e.message); }
  }
  try {
    if (admin.apps && admin.apps.length === 0) {
      if (creds) {
        admin.initializeApp({ credential: admin.credential.cert(creds) });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({ credential: admin.credential.applicationDefault() });
      } else {
        console.warn('[push] FCM credentials not configured — Android push disabled');
        return false;
      }
    }
    _fcmReady = true;
    console.log('[push] FCM initialised');
  } catch (e) {
    console.error('[push] FCM init failed:', e.message);
  }
  return _fcmReady;
}

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ---- VAPID keypair lifecycle ----------------------------------------

let _vapid = null;
async function ensureVapid() {
  if (_vapid) return _vapid;
  const envPub  = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    _vapid = { publicKey: envPub, privateKey: envPriv, source: 'env' };
  } else {
    // Try config table next.
    const cfgPub  = await db.getConfig('VAPID_PUBLIC_KEY', '');
    const cfgPriv = await db.getConfig('VAPID_PRIVATE_KEY', '');
    if (cfgPub && cfgPriv) {
      _vapid = { publicKey: cfgPub, privateKey: cfgPriv, source: 'db' };
    } else if (webpush) {
      // First ever boot — generate a fresh pair, persist it.
      const k = webpush.generateVAPIDKeys();
      await db.setConfig('VAPID_PUBLIC_KEY', k.publicKey);
      await db.setConfig('VAPID_PRIVATE_KEY', k.privateKey);
      _vapid = { publicKey: k.publicKey, privateKey: k.privateKey, source: 'generated' };
      console.log('[push] generated new VAPID keypair and persisted to config table');
    }
  }
  if (_vapid && webpush) {
    const subject = process.env.VAPID_SUBJECT || (process.env.BASE_URL || 'mailto:gopalvserve@gmail.com');
    webpush.setVapidDetails(
      subject.startsWith('http') || subject.startsWith('mailto:') ? subject : ('mailto:' + subject),
      _vapid.publicKey,
      _vapid.privateKey
    );
  }
  return _vapid;
}

// Ensure subscriptions tables exist on boot. Runs once at module load.
async function ensureSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        ua TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (endpoint)
      )
    `);
    // FCM tokens — one row per (user, device). Token is the unique key so a
    // device re-installing the app simply refreshes its row instead of
    // duplicating. `platform` left for future iOS support.
    await db.query(`
      CREATE TABLE IF NOT EXISTS fcm_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        platform TEXT,
        ua TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (token)
      )
    `);
  } catch (e) {
    console.warn('[push] could not ensure push tables:', e.message);
  }
}
ensureSchema();
ensureVapid().catch(e => console.warn('[push] vapid init failed:', e.message));
_initFcm();

// ---- API endpoints --------------------------------------------------

async function api_push_publicKey(token) {
  await authUser(token);
  const v = await ensureVapid();
  if (!v) return { publicKey: '' };
  return { publicKey: v.publicKey };
}

async function api_push_subscribe(token, subscription, ua) {
  const me = await authUser(token);
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Invalid subscription payload');
  }
  const endpoint = String(subscription.endpoint);
  const p256dh = String(subscription.keys.p256dh || '');
  const auth   = String(subscription.keys.auth || '');
  if (!p256dh || !auth) throw new Error('Subscription missing keys');

  // Upsert by endpoint — same browser re-subscribing should refresh the row,
  // not duplicate. Different users / browsers each get their own row.
  await db.query(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        ua = EXCLUDED.ua
  `, [me.id, endpoint, p256dh, auth, String(ua || '').slice(0, 250)]);
  return { ok: true };
}

async function api_push_unsubscribe(token, endpoint) {
  await authUser(token);
  if (!endpoint) return { ok: true };
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [String(endpoint)]);
  return { ok: true };
}

/**
 * Register an FCM device token. Called from the Capacitor app immediately
 * after `PushNotifications.register()` succeeds. The `fcmToken` is what
 * Google gives the device — opaque, ~150 chars, refreshes occasionally.
 *
 * Args: (token, fcmToken, platform, ua)
 *   - platform: 'android' | 'ios'
 */
async function api_fcm_register(token, fcmToken, platform, ua) {
  const me = await authUser(token);
  if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.length < 20) {
    throw new Error('Invalid FCM token');
  }
  await db.query(`
    INSERT INTO fcm_tokens (user_id, token, platform, ua)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        ua = EXCLUDED.ua
  `, [me.id, fcmToken, String(platform || 'android'), String(ua || '').slice(0, 250)]);
  return { ok: true };
}

async function api_fcm_unregister(token, fcmToken) {
  await authUser(token);
  if (!fcmToken) return { ok: true };
  await db.query(`DELETE FROM fcm_tokens WHERE token = $1`, [String(fcmToken)]);
  return { ok: true };
}

/**
 * Admin/debug — send a test push to the current user. Helps confirm the
 * subscription works end-to-end. Available to any logged-in user for their
 * own device(s).
 */
async function api_push_test(token, payload) {
  const me = await authUser(token);
  const body = (payload && typeof payload === 'object') ? payload : {};
  const out = await sendPushToUser(me.id, {
    title: body.title || '🔔 Test notification',
    body:  body.body  || 'If you see this on your phone, push notifications are working.',
    url:   body.url   || '/'
  });
  return out;
}

// ---- Push sender ---------------------------------------------------

/**
 * Send a Web Push to every subscription registered for `userId`. Browser /
 * desktop Chrome / installed PWA fan-out lives here.
 * Payload should be { title, body, url, tag?, icon? }.
 * Bad subscriptions (404 / 410) are deleted automatically.
 */
async function _sendWebPush(userId, payload) {
  if (!webpush) return { sent: 0, failed: 0, skipped: 'web-push not installed' };
  await ensureVapid();
  if (!_vapid) return { sent: 0, failed: 0, skipped: 'vapid keys missing' };

  const { rows } = await db.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [Number(userId)]
  );
  if (!rows.length) return { sent: 0, failed: 0 };

  const json = JSON.stringify({
    title: String(payload.title || 'Lead CRM'),
    body:  String(payload.body  || ''),
    url:   String(payload.url   || '/'),
    tag:   payload.tag || undefined,
    icon:  payload.icon || '/icon-192.png'
  });

  let sent = 0, failed = 0;
  await Promise.all(rows.map(async row => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, json, { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      failed++;
      const code = (e && e.statusCode) || 0;
      if (code === 404 || code === 410) {
        try {
          const { rows: ageRows } = await db.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_s FROM push_subscriptions WHERE id = $1`,
            [row.id]
          );
          const ageS = Number(ageRows[0]?.age_s || 0);
          if (ageS > 60) {
            await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]);
          } else {
            console.warn('[push] new subscription returned ' + code + ', keeping (age ' + Math.round(ageS) + 's)');
          }
        } catch (_) {}
      } else {
        console.warn('[push] webpush send failed:', code, e.message);
      }
    }
  }));
  return { sent, failed };
}

/**
 * Send an FCM push to every Android/iOS device registered for `userId`.
 * Uses firebase-admin to talk to FCM. Native devices show banner + sound +
 * vibration even when the app is fully closed. Stale tokens (404/UNREGISTERED)
 * get evicted from the table automatically.
 */
async function _sendFcm(userId, payload) {
  if (!admin || !_initFcm()) return { sent: 0, failed: 0, skipped: 'fcm not configured' };

  const { rows } = await db.query(
    `SELECT id, token FROM fcm_tokens WHERE user_id = $1`,
    [Number(userId)]
  );
  if (!rows.length) return { sent: 0, failed: 0 };

  const title = String(payload.title || 'Lead CRM');
  const body  = String(payload.body  || '');
  const url   = String(payload.url   || '/');

  let sent = 0, failed = 0;
  await Promise.all(rows.map(async row => {
    try {
      // Single message per token so a single bad device doesn't poison the batch.
      // `notification` block makes Android show the banner automatically when
      // the app is in the background or closed. `data` block carries the URL
      // so a tap can navigate inside the WebView.
      // NOTE: removed clickAction: 'FCM_PLUGIN_ACTIVITY' — that required
      // a matching <intent-filter> in AndroidManifest which we don't have.
      // Without it, taps on the notification did nothing (the activity
      // resolver returned null). Default Capacitor behaviour (no clickAction)
      // opens the launcher activity and fires pushNotificationActionPerformed
      // — which is exactly what we want.
      await admin.messaging().send({
        token: row.token,
        notification: { title, body },
        data: { url, tag: String(payload.tag || ''), title, body },
        android: {
          priority: 'high',
          notification: {
            channelId: 'lead-crm-default',
            sound: 'default',
            defaultVibrateTimings: true,
            tag: String(payload.tag || '')
          }
        }
      });
      sent++;
    } catch (e) {
      failed++;
      const code = (e && e.errorInfo && e.errorInfo.code) || (e && e.code) || '';
      // Standard FCM error codes for "this token is dead":
      //   messaging/registration-token-not-registered
      //   messaging/invalid-registration-token
      if (/not-registered|invalid-registration-token|invalid-argument/i.test(code)) {
        try { await db.query(`DELETE FROM fcm_tokens WHERE id = $1`, [row.id]); } catch (_) {}
      } else {
        console.warn('[push] fcm send failed:', code, e.message);
      }
    }
  }));
  return { sent, failed };
}

/**
 * Public sender — fan out to BOTH Web Push (browser/PWA) AND FCM (native APK).
 * Either channel may have zero subscriptions; that's fine.
 *
 * Returns { sent, failed, web, fcm } so callers can see where the delivery
 * actually happened in the logs.
 */
async function sendPushToUser(userId, payload) {
  const [web, fcm] = await Promise.all([
    _sendWebPush(userId, payload).catch(e => ({ sent: 0, failed: 0, error: e.message })),
    _sendFcm(userId, payload).catch(e => ({ sent: 0, failed: 0, error: e.message }))
  ]);
  return {
    sent:   (web.sent   || 0) + (fcm.sent   || 0),
    failed: (web.failed || 0) + (fcm.failed || 0),
    web, fcm
  };
}

/**
 * Dial-via-mobile — desktop CRM clicks "Call from phone" on a lead, server
 * pushes an FCM message to the user's Android device, the APK receives it
 * and opens its native dialer with the number pre-filled. The user just taps
 * the call button on their phone — no need to type the number.
 *
 * Mechanism:
 *  - Push payload includes data.type='call_request' + phone + lead_name + a
 *    URL like '/#/dial?phone=+91...'
 *  - When the user taps the notification, the APK opens that URL inside
 *    the WebView, which immediately fires `tel:` and opens the dialer.
 */
async function api_call_via_mobile(token, leadId, phone, leadName) {
  const me = await authUser(token);
  const target = String(phone || '').trim();
  if (!target) throw new Error('phone required');
  const name = String(leadName || ('Lead #' + (leadId || ''))).slice(0, 60);
  const url = '/#/dial?phone=' + encodeURIComponent(target) + (leadId ? '&lead=' + Number(leadId) : '');

  // Log a call_events row immediately so the downstream recording sync
  // has a reference point to match against (api_call_hasRecentEvent).
  // Without this, "dial from desktop" calls produced no event until the
  // native broadcast receiver fired on the phone — and on phones where
  // the receiver doesn't fire, the recording would never get attached
  // to the lead.
  try {
    await db.insert('call_events', {
      lead_id: leadId || null,
      user_id: me.id,
      phone: target,
      direction: 'out',
      event: 'dial_requested',
      duration_s: 0,
      recording_id: null,
      created_at: db.nowIso()
    });
  } catch (e) {
    console.warn('[push] dial_requested event insert failed:', e.message);
  }

  const r = await sendPushToUser(me.id, {
    title: '📞 Tap to call ' + name,
    body:  target,
    url,
    tag:   'dial-' + Date.now(),
    sticky: false
  });
  return { ok: true, push: r };
}

module.exports = {
  api_push_publicKey, api_push_subscribe, api_push_unsubscribe, api_push_test,
  api_fcm_register, api_fcm_unregister,
  api_call_via_mobile,
  sendPushToUser
};

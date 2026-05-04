const db = require('../db/pg');
const jwt = require('jsonwebtoken');
const { signToken, verifyPassword, authUser, hashPassword } = require('../utils/auth');
const totp = require('../utils/totp');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

/**
 * Login flow:
 *   - email + password OK and TOTP not enabled → return final session token.
 *   - email + password OK and TOTP enabled    → return a short-lived
 *     "challenge" token instead. Caller must POST { fn:'api_login_otp_verify', args:[challenge,otp] }
 *     to exchange it for the real session token.
 *
 * The challenge token carries `pending_otp: true` and only `id` of the user,
 * signed with the same JWT secret. It expires after 5 minutes — enough for
 * the user to fish out their phone, not so long that a stolen password is
 * useful by itself.
 */
async function api_login(email, password, meta) {
  if (!email || !password) throw new Error('Email and password required');
  const user = await db.findOneBy('users', 'email', String(email).toLowerCase().trim());
  if (!user || !user.is_active) throw new Error('Invalid email or password');
  if (!verifyPassword(password, user.password_hash)) throw new Error('Invalid email or password');

  if (Number(user.totp_enabled) === 1 && user.totp_secret) {
    const challenge = jwt.sign({ id: user.id, pending_otp: true }, JWT_SECRET, { expiresIn: '5m' });
    return {
      needs_otp: true,
      challenge_token: challenge,
      user: { name: user.name, email: user.email }
    };
  }

  const token = signToken(user);
  setImmediate(async () => {
    try {
      const mailer = require('../utils/mailer');
      const fakeReq = { headers: { 'user-agent': (meta && meta.ua) || '', 'x-forwarded-for': (meta && meta.ip) || '' }, connection: {} };
      const r = await mailer.recordLogin(user.id, fakeReq);
      if (r.isNew && user.email) {
        await mailer.sendEvent('new_device_login', {
          to: user.email,
          user_first_name: (user.name || '').split(' ')[0],
          user_name: user.name,
          login_time: new Date().toLocaleString('en-IN'),
          ip: r.ip || '', user_agent: r.ua || ''
        });
      }
    } catch (e) { console.warn('[auth] device-login notify failed:', e.message); }
  });
  return {
    token,
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, parent_id: user.parent_id,
      department: user.department, photo_url: user.photo_url
    }
  };
}

/**
 * Step 2 of 2FA login — exchange the challenge token + OTP for a real session.
 */
async function api_login_otp_verify(challengeToken, otp, meta) {
  if (!challengeToken) throw new Error('Challenge token missing');
  let payload;
  try { payload = jwt.verify(challengeToken, JWT_SECRET); }
  catch (e) { throw new Error('Challenge expired — please log in again'); }
  if (!payload.pending_otp) throw new Error('Invalid challenge');
  const user = await db.findById('users', payload.id);
  if (!user || !user.is_active) throw new Error('Account no longer active');
  if (!user.totp_secret || Number(user.totp_enabled) !== 1) throw new Error('2FA is not configured for this account');
  if (!totp.verify(user.totp_secret, otp)) throw new Error('Invalid 6-digit code — check your authenticator app');

  const token = signToken(user);
  return {
    token,
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, parent_id: user.parent_id,
      department: user.department, photo_url: user.photo_url
    }
  };
}

async function api_me(token) {
  const user = await authUser(token);
  return {
    id: user.id, name: user.name, email: user.email,
    role: user.role, parent_id: user.parent_id,
    department: user.department, photo_url: user.photo_url,
    totp_enabled: Number(user.totp_enabled) === 1,
    calendly_url: user.calendly_url || ''
  };
}

async function api_logout() { return { ok: true }; }

async function api_changePassword(token, oldPassword, newPassword) {
  const user = await authUser(token);
  if (!verifyPassword(oldPassword, user.password_hash)) throw new Error('Old password is wrong');
  await db.update('users', user.id, { password_hash: hashPassword(newPassword) });
  return { ok: true };
}

/**
 * Begin 2FA setup — generate a fresh secret, save it (unverified), and
 * return the otpauth:// URL the user's authenticator app will scan, plus
 * the raw base32 secret for manual entry as a fallback.
 *
 * The secret is saved with totp_enabled=0 so a half-set-up account can
 * still log in normally. It only flips to enabled once the user proves
 * they can generate valid codes via api_2fa_setup_verify.
 */
async function api_2fa_setup_start(token) {
  const user = await authUser(token);
  const secret = totp.generateSecret();
  await db.update('users', user.id, { totp_secret: secret, totp_enabled: 0 });
  const brand = await db.getConfig('COMPANY_NAME', '').catch(() => '') || process.env.BRAND_NAME || 'CRM';
  const url = totp.buildOtpauthUrl(secret, user.email, brand);
  return { secret, otpauth_url: url, issuer: brand, account: user.email };
}

/**
 * Confirm 2FA setup by submitting one valid OTP. Flips totp_enabled=1
 * and stamps totp_verified_at.
 */
async function api_2fa_setup_verify(token, otp) {
  const user = await authUser(token);
  if (!user.totp_secret) throw new Error('Run setup first');
  if (!totp.verify(user.totp_secret, otp)) throw new Error('Invalid code — try again with the latest 6 digits');
  await db.update('users', user.id, { totp_enabled: 1, totp_verified_at: db.nowIso() });
  return { ok: true };
}

/**
 * Disable 2FA — requires the current password (defence against a hijacked
 * session token) and a current OTP (defence against a hijacked password).
 */
async function api_2fa_disable(token, password, otp) {
  const user = await authUser(token);
  if (!verifyPassword(password, user.password_hash)) throw new Error('Wrong password');
  if (Number(user.totp_enabled) === 1) {
    if (!user.totp_secret || !totp.verify(user.totp_secret, otp)) throw new Error('Invalid 6-digit code');
  }
  await db.update('users', user.id, { totp_secret: null, totp_enabled: 0, totp_verified_at: null });
  return { ok: true };
}

/**
 * Admin-only: forcibly clear another user's 2FA — for the case where a
 * user has lost their phone. The admin's own 2FA must be valid in their
 * existing session token, so this still requires recent authentication.
 */
async function api_2fa_admin_reset(token, targetUserId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.update('users', targetUserId, { totp_secret: null, totp_enabled: 0, totp_verified_at: null });
  return { ok: true };
}

module.exports = {
  api_login, api_login_otp_verify, api_me, api_logout, api_changePassword,
  api_2fa_setup_start, api_2fa_setup_verify, api_2fa_disable, api_2fa_admin_reset
};

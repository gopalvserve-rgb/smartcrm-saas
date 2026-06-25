/**
 * R2_RECORDINGS_v1 — Cloudflare R2 (S3-compatible) storage for call recordings.
 *
 * Why: serving audio bytes through the Node app counts as Railway egress
 * (the main driver of the networking bill). R2 has ZERO egress, so we
 * upload recordings here and hand the browser a short-lived presigned URL
 * — playback bytes then come straight from Cloudflare, not Railway.
 *
 * Fully env-gated: if the R2_* vars aren't set, isEnabled() is false and
 * every caller falls back to the existing Postgres bytea behaviour.
 *
 * Required env vars (set in Railway → Variables):
 *   R2_ENDPOINT          https://<account-id>.r2.cloudflarestorage.com   (NO bucket suffix)
 *   R2_BUCKET            smartcrm-recordings
 *   R2_ACCESS_KEY_ID     <R2 API token access key id>
 *   R2_SECRET_ACCESS_KEY <R2 API token secret>
 *   R2_ACCOUNT_ID        <account id>   (optional; informational)
 */
let _client = null;

function _cfg() {
  return {
    endpoint: process.env.R2_ENDPOINT || '',
    bucket:   process.env.R2_BUCKET || '',
    ak:       process.env.R2_ACCESS_KEY_ID || '',
    sk:       process.env.R2_SECRET_ACCESS_KEY || ''
  };
}

function isEnabled() {
  const c = _cfg();
  return !!(c.endpoint && c.bucket && c.ak && c.sk);
}

function _s3() {
  if (_client) return _client;
  const c = _cfg();
  const { S3Client } = require('@aws-sdk/client-s3');
  _client = new S3Client({
    region: 'auto',
    endpoint: c.endpoint,
    forcePathStyle: true,        // safest with the R2 account endpoint
    credentials: { accessKeyId: c.ak, secretAccessKey: c.sk }
  });
  return _client;
}

async function putObject(key, body, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const c = _cfg();
  await _s3().send(new PutObjectCommand({
    Bucket: c.bucket, Key: key, Body: body,
    ContentType: contentType || 'application/octet-stream'
  }));
  return key;
}

async function presignGet(key, expiresSec) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const c = _cfg();
  return getSignedUrl(_s3(), new GetObjectCommand({ Bucket: c.bucket, Key: key }), {
    expiresIn: Math.max(30, Number(expiresSec) || 300)
  });
}

async function getObjectBuffer(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const c = _cfg();
  const r = await _s3().send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
  const chunks = [];
  for await (const ch of r.Body) chunks.push(ch);
  return Buffer.concat(chunks);
}

async function deleteObject(key) {
  if (!key) return;
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const c = _cfg();
    await _s3().send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
  } catch (e) { /* best-effort — don't block retention on R2 hiccups */ }
}

module.exports = { isEnabled, putObject, presignGet, getObjectBuffer, deleteObject, _cfg };

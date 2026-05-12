/**
 * utils/audioTranscode.js — convert call-recording audio so browsers can play it.
 *
 * Background: Samsung's stock dialer on many devices writes calls as
 * 3GPP container with AMR-NB codec inside. No web browser ships an
 * AMR decoder — not Chrome, not Safari, not Android WebView, not
 * Firefox. So even though the bytes are perfect, <audio> refuses to
 * play them.
 *
 * The portable answer is to transcode AMR/3GP → MP3 on our server.
 * MP3 plays in literally every browser, every OS, every embedded
 * player. The size penalty is small (call recordings are typically
 * 5–20 KB/sec; MP3 at 64 kbps is 8 KB/sec).
 *
 * We rely on the system ffmpeg binary (Dockerfile does `apk add
 * ffmpeg`). The Node side is just fluent-ffmpeg orchestration.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let _ffmpegAvailable = null;  // tri-state: null=unknown, true/false=tested
let _ffmpeg;
let _ffmpegBinary = null;  // resolved path to the ffmpeg binary
try { _ffmpeg = require('fluent-ffmpeg'); }
catch (_) { _ffmpeg = null; }

// Resolve ffmpeg binary path: prefer system ffmpeg (Nixpacks/Alpine apk),
// fall back to ffmpeg-static (bundled in node_modules). Either guarantees
// the transcode works regardless of how the host is provisioned.
if (_ffmpeg) {
  try {
    // ffmpeg-static exports the absolute path to a precompiled binary
    const _static = require('ffmpeg-static');
    if (_static && typeof _static === 'string') {
      _ffmpegBinary = _static;
      _ffmpeg.setFfmpegPath(_static);
      console.log('[audio-transcode] using ffmpeg-static at', _static);
    }
  } catch (e) {
    console.warn('[audio-transcode] ffmpeg-static not installed:', e.message);
  }
}

function getFfmpegBinary() { return _ffmpegBinary; }

/**
 * Heuristic from the first 16 bytes — returns true when the browser is
 * known NOT to be able to play this codec/container natively.
 */
function needsTranscode(buf) {
  if (!buf || buf.length < 12) return false;
  // ISO Base Media: bytes 4–8 say 'ftyp', 8–12 are the major brand.
  const ftypMarker = buf.slice(4, 8).toString('ascii');
  if (ftypMarker === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii').trim();
    // 3gp4 / 3gp5 / 3gpp / 3g2a — usually AMR-NB or AMR-WB inside
    if (brand.indexOf('3gp') === 0 || brand === '3gpp' || brand === '3g2a') return true;
  }
  // Standalone AMR file ('#!AMR\n' for NB, '#!AMR-WB\n' for WB)
  if (buf.slice(0, 4).toString('ascii') === '#!AM') return true;
  return false;
}

async function _verifyFfmpeg() {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  if (!_ffmpeg) { _ffmpegAvailable = false; return false; }
  return new Promise(resolve => {
    _ffmpeg.getAvailableCodecs((err, codecs) => {
      if (err) { _ffmpegAvailable = false; return resolve(false); }
      _ffmpegAvailable = true;
      resolve(true);
    });
  });
}

/**
 * Transcode AMR/3GP/anything-ffmpeg-can-read → MP3.
 * Returns the MP3 Buffer (or null if ffmpeg isn't available).
 *
 * Writes temp files into os.tmpdir() with unique names. Best-effort
 * cleanup — leftover temp files in tmpdir are reaped by the OS so it's
 * not catastrophic if a process crashes mid-transcode.
 */
async function transcodeToMp3(buf) {
  // Wrap EVERYTHING in try/catch — return null on any failure so the
  // caller can fall back to serving the original bytes. Never throws.
  try {
    const ok = await _verifyFfmpeg();
    if (!ok) {
      console.warn('[audio-transcode] ffmpeg not available — cannot transcode');
      return null;
    }
    const uid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const inPath  = path.join(os.tmpdir(), 'rec-in-'  + uid);
    const outPath = path.join(os.tmpdir(), 'rec-out-' + uid + '.mp3');
    try {
      await fs.promises.writeFile(inPath, buf);
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn) => (arg) => { if (!settled) { settled = true; fn(arg); } };
        const timer = setTimeout(() => finish(reject)(new Error('ffmpeg timed out after 30s')), 30_000);
        _ffmpeg(inPath)
          .audioCodec('libmp3lame')
          .audioBitrate('64k')
          .audioFrequency(22050)
          .audioChannels(1)
          .format('mp3')
          .on('error', (err) => { clearTimeout(timer); finish(reject)(err); })
          .on('end',   () => { clearTimeout(timer); finish(resolve)(); })
          .save(outPath);
      });
      // Sanity check: MP3 starts with 'ID3' or an MPEG frame header (0xFF 0xFn)
      const out = await fs.promises.readFile(outPath);
      if (!out || out.length < 256) {
        console.warn('[audio-transcode] output too small (' + (out ? out.length : 0) + ' bytes), discarding');
        return null;
      }
      const head = out.slice(0, 3);
      const looksMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)  // 'ID3'
                    || (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0);             // MPEG sync
      if (!looksMp3) {
        console.warn('[audio-transcode] output header doesn\'t look like MP3, discarding');
        return null;
      }
      return out;
    } finally {
      fs.promises.unlink(inPath).catch(() => {});
      fs.promises.unlink(outPath).catch(() => {});
    }
  } catch (e) {
    console.warn('[audio-transcode] failed (returning null):', e && e.message);
    return null;
  }
}

module.exports = { needsTranscode, transcodeToMp3, getFfmpegBinary };

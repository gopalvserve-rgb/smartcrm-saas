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
try { _ffmpeg = require('fluent-ffmpeg'); }
catch (_) { _ffmpeg = null; }

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
  const ok = await _verifyFfmpeg();
  if (!ok) return null;
  const uid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const inPath  = path.join(os.tmpdir(), 'rec-in-'  + uid);
  const outPath = path.join(os.tmpdir(), 'rec-out-' + uid + '.mp3');
  await fs.promises.writeFile(inPath, buf);
  try {
    await new Promise((resolve, reject) => {
      _ffmpeg(inPath)
        .audioCodec('libmp3lame')
        .audioBitrate('64k')
        .audioFrequency(22050)
        .audioChannels(1)            // mono — calls are mono anyway
        .format('mp3')
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });
    const out = await fs.promises.readFile(outPath);
    return out;
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { needsTranscode, transcodeToMp3 };

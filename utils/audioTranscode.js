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

// Resolve ffmpeg binary path. Try every source so this NEVER breaks on
// a fresh deploy: (1) ffmpeg-static (npm, precompiled binary), (2)
// @ffmpeg-installer/ffmpeg (alternative npm package), (3) system ffmpeg
// on PATH (apk add ffmpeg in Docker / nixpacks ffmpeg-full on Railway).
// Each require() is wrapped — missing/broken packages don't crash boot.
if (_ffmpeg) {
  // Try (1) ffmpeg-static
  try {
    const _static = require('ffmpeg-static');
    if (_static && typeof _static === 'string') {
      const fs = require('fs');
      if (fs.existsSync(_static)) {
        _ffmpegBinary = _static;
        _ffmpeg.setFfmpegPath(_static);
        console.log('[audio-transcode] using ffmpeg-static at', _static);
      } else {
        console.warn('[audio-transcode] ffmpeg-static path missing:', _static);
      }
    }
  } catch (e) {
    console.warn('[audio-transcode] ffmpeg-static unavailable:', e.message);
  }
  // Try (2) @ffmpeg-installer/ffmpeg
  if (!_ffmpegBinary) {
    try {
      const _alt = require('@ffmpeg-installer/ffmpeg');
      if (_alt && _alt.path) {
        const fs = require('fs');
        if (fs.existsSync(_alt.path)) {
          _ffmpegBinary = _alt.path;
          _ffmpeg.setFfmpegPath(_alt.path);
          console.log('[audio-transcode] using @ffmpeg-installer/ffmpeg at', _alt.path);
        }
      }
    } catch (e) { /* expected if not installed */ }
  }
  // Try (3) system ffmpeg on PATH — works on Railway nixpacks (ffmpeg-full)
  // and Docker Alpine (apk add ffmpeg).
  if (!_ffmpegBinary) {
    try {
      const cp = require('child_process');
      const out = cp.execSync('command -v ffmpeg || which ffmpeg', { encoding: 'utf8', timeout: 3000 }).trim();
      if (out) {
        _ffmpegBinary = out;
        _ffmpeg.setFfmpegPath(out);
        console.log('[audio-transcode] using system ffmpeg at', out);
      }
    } catch (e) { /* ffmpeg not on PATH */ }
  }
  if (!_ffmpegBinary) {
    console.warn('[audio-transcode] no ffmpeg binary found — 3GP/AMR recordings will not transcode');
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
    // M4A / mp42 / isom — already our target format, nothing to do
    return false;
  }
  // Standalone AMR file ('#!AMR\n' for NB, '#!AMR-WB\n' for WB)
  if (buf.slice(0, 4).toString('ascii') === '#!AM') return true;
  // FLAC magic 'fLaC' — Safari/iOS can't decode FLAC, transcode it.
  if (buf.slice(0, 4).toString('ascii') === 'fLaC') return true;
  // Ogg Vorbis — Safari can't, transcode it
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return true;
  // WAV — fine in browser, but huge. Transcode to AAC to save space.
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return true;
  // MP3 (any) — we used to produce MP3 here but switched to MP4/AAC.
  // ANY non-MP4 file should be transcoded so the entire tenant ends up
  // on a single, browser-friendly container. This auto-fixes the old
  // 22kHz MPEG-2 MP3s that previous deploys cached — first play on
  // each will trigger an automatic re-transcode to AAC/m4a.
  if (buf.slice(0, 3).toString('ascii') === 'ID3') return true;
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;
  return false;
}

/**
 * Map filename extension + magic bytes to a Content-Type the browser
 * understands. Covers every format the APK file-scanner accepts:
 *   .mp3 .wav .ogg .flac .m4a .amr .aac .3gp .opus
 *
 * Magic-byte sniffing wins over filename when both are available — the
 * file may have been renamed, but the bytes never lie.
 */
function guessAudioMime(filename, buf) {
  // Try magic bytes first (most reliable)
  if (buf && buf.length >= 12) {
    const head4 = buf.slice(0, 4).toString('ascii');
    const ftyp  = buf.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') {
      const brand = buf.slice(8, 12).toString('ascii').trim();
      if (brand === 'M4A'  || brand === 'mp42' || brand === 'mp41'
       || brand === 'isom' || brand === 'iso2') return 'audio/mp4';
      if (brand.indexOf('3gp') === 0 || brand === '3gpp' || brand === '3g2a') return 'audio/3gpp';
    }
    if (head4 === '#!AM')  return 'audio/amr';     // AMR-NB or AMR-WB
    if (head4 === 'RIFF')  return 'audio/wav';
    if (head4 === 'OggS')  return 'audio/ogg';
    if (head4 === 'fLaC')  return 'audio/flac';
    if (head4 === 'ID3\x03' || head4 === 'ID3\x04' || head4.startsWith('ID3')) return 'audio/mpeg';
    if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'audio/mpeg';  // MPEG sync
  }
  // Fall back to filename extension
  const lower = String(filename || '').toLowerCase();
  const ext = lower.split('.').pop();
  switch (ext) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'ogg':
    case 'oga':  return 'audio/ogg';
    case 'opus': return 'audio/opus';
    case 'flac': return 'audio/flac';
    case 'm4a':
    case 'mp4':
    case 'aac':  return 'audio/mp4';
    case 'amr':  return 'audio/amr';
    case '3gp':
    case '3gpp': return 'audio/3gpp';
    default:     return 'application/octet-stream';
  }
}

/**
 * Is this MIME type playable directly in a browser (no transcode)?
 * Used to set X-Audio-Browser-Playable on the response.
 */
function isBrowserPlayable(mime) {
  const m = String(mime || '').toLowerCase();
  // mp3/mp4 (AAC)/wav/ogg/opus play in every modern browser
  if (m === 'audio/mpeg' || m === 'audio/mp4' || m === 'audio/wav'
   || m === 'audio/ogg' || m === 'audio/opus') return true;
  // FLAC plays on Chrome/Firefox but NOT Safari/iOS — treat as needs-transcode
  // AMR/3GPP never play in any browser
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
        let _stderr = '';
      _ffmpeg(inPath)
          .audioCodec('aac')          // AAC in MP4 container = m4a.
                                       // Android WebView has had built-in
                                       // AAC decode since Android 1.0;
                                       // it's the safest browser/mobile
                                       // audio target by a wide margin.
                                       // MP3 (even MPEG-1) failed to play
                                       // in WebView even when /audio
                                       // served bytes correctly.
          .audioBitrate('64k')
          .audioFrequency(44100)
          .audioChannels(1)
          .outputOptions([
            '-movflags', '+faststart'  // moov atom up front so the
                                       // browser can start playback
                                       // without downloading the entire
                                       // file first
          ])
          .format('mp4')               // ffmpeg's name; produces .m4a
          .on('stderr', line => { _stderr += line + '\n'; })
          .on('error', (err) => {
            clearTimeout(timer);
            err._stderr = _stderr.slice(-1500);
            finish(reject)(err);
          })
          .on('end',   () => { clearTimeout(timer); finish(resolve)(); })
          .save(outPath);
      });
      // Sanity check: MP3 starts with 'ID3' or an MPEG frame header (0xFF 0xFn)
      const out = await fs.promises.readFile(outPath);
      if (!out || out.length < 256) {
        console.warn('[audio-transcode] output too small (' + (out ? out.length : 0) + ' bytes), discarding');
        return null;
      }
      // Now producing MP4/m4a: bytes 4-8 should be 'ftyp' and the major
      // brand at 8-12 starts with 'mp4' or 'M4A' or 'isom' / 'iso2'.
      const ftypMarker = out.slice(4, 8).toString('ascii');
      const brand      = out.slice(8, 12).toString('ascii').trim();
      const looksMp4 = ftypMarker === 'ftyp' && (
        brand === 'M4A' || brand === 'mp42' || brand === 'mp41'
     || brand === 'isom' || brand === 'iso2' || brand === 'iso5'
     || brand === 'dash'
      );
      if (!looksMp4) {
        console.warn('[audio-transcode] output header is not MP4 (ftyp=' + ftypMarker + ' brand=' + brand + '), discarding');
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

module.exports = { needsTranscode, transcodeToMp3, getFfmpegBinary, guessAudioMime, isBrowserPlayable };

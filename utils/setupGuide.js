/**
 * utils/setupGuide.js
 *
 * In-memory search index over the Setup Guide (public/saas/help/index.html).
 * The Copilot calls `lookup(query)` and gets the top-matching sections back
 * as plain-text snippets so it can synthesise a precise answer rooted in
 * the actual guide content.
 *
 * Why parse the HTML at runtime rather than maintaining a separate JSON?
 * The HTML is the source of truth for end users. If we duplicated it into
 * JSON, the two would drift. Parsing once at boot keeps them in lockstep.
 *
 * Index is built lazily on first call and cached for the process lifetime.
 * Each section becomes:
 *   { id, title, keywords, body, url }
 * where `body` is the visible text with HTML tags stripped, ~1000 chars
 * truncated to keep the prompt budget under control.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'public', 'saas', 'help', 'index.html');
const PUBLIC_URL = 'https://crm.smartcrmsolution.com/saas/help/';

let _index = null;

function _stripHtml(s) {
  // Tags out, decode common entities, collapse whitespace
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function _buildIndex() {
  let html = '';
  try { html = fs.readFileSync(HTML_PATH, 'utf8'); }
  catch (e) {
    console.warn('[setupGuide] could not read help HTML:', e.message);
    return [];
  }
  // Pull every <article class="section" id="..." data-keywords="...">...</article>
  const rx = /<article\s+class="section"\s+id="([^"]+)"\s+data-keywords="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi;
  const out = [];
  let m;
  while ((m = rx.exec(html))) {
    const id = m[1];
    const keywords = m[2];
    const inner = m[3];
    // Title = text inside the <h2> (drop the <span class="num">..</span>)
    const titleMatch = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(inner);
    const titleRaw = titleMatch ? titleMatch[1] : id;
    const title = _stripHtml(titleRaw.replace(/<span\s+class="num">[\s\S]*?<\/span>/i, '')).trim();
    const body = _stripHtml(inner).slice(0, 1500);
    out.push({
      id,
      title,
      keywords: keywords.toLowerCase(),
      body,
      url: PUBLIC_URL + '#' + id
    });
  }
  return out;
}

function getIndex() {
  if (_index) return _index;
  _index = _buildIndex();
  console.log('[setupGuide] indexed ' + _index.length + ' sections');
  return _index;
}

/**
 * Score a section against a query. Token-based: each query token that
 * appears in keywords or title gets weighted, body matches are weaker.
 */
function _score(section, tokens) {
  if (!tokens.length) return 0;
  const t = section.title.toLowerCase();
  const k = section.keywords;
  const b = section.body.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) score += 8;
    if (k.includes(tok)) score += 5;
    if (b.includes(tok)) score += 1;
  }
  return score;
}

/**
 * Search the guide. Returns up to `limit` sections sorted by relevance.
 * Each result has { id, title, url, body } — body trimmed to ~600 chars
 * for the LLM prompt budget.
 *
 *   const hits = setupGuide.lookup('pabbly campaign name', 3);
 */
function lookup(query, limit) {
  const lim = Math.max(1, Math.min(5, Number(limit) || 3));
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[^a-z0-9]+/i).filter(t => t && t.length > 1);
  if (!tokens.length) return [];
  const idx = getIndex();
  const scored = idx
    .map(s => ({ s, score: _score(s, tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, lim);
  return scored.map(({ s }) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    body: s.body.slice(0, 600)
  }));
}

module.exports = { lookup, getIndex };

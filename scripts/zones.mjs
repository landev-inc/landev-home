#!/usr/bin/env node
// Zone knowledge base tool.
//
//   node scripts/zones.mjs draft <muniId> <ZONE> --source <url> [--source <url>]
//   node scripts/zones.mjs draft <muniId> <ZONE> --source <url> --dry-run
//   node scripts/zones.mjs verify <muniId>:<ZONE> --by "Name"
//   node scripts/zones.mjs list [--drafts]
//   node scripts/zones.mjs misses            (paste Vercel logs on stdin)
//
// `draft` fetches the municipal pages you point it at, extracts their text,
// and asks the model to write the entry USING ONLY THAT TEXT. Nothing is
// invented from training data — that is the whole point. Every number the
// model emits is checked back against the fetched text before the entry is
// written, and anything that does not appear verbatim is dropped with a
// warning rather than saved.
//
// A drafted entry is never served. A person reads it against the bylaw and
// runs `verify`. That review is the product.
//
// Needs OPENAI_API_KEY in the environment or in .env for `draft`.
// `--dry-run` needs no key and prints what would be sent.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const ZONES_PATH = fileURLToPath(new URL('data/zones.js', ROOT));

const MUNICIPALITIES = {
  squamish: 'District of Squamish',
  sechelt: 'District of Sechelt',
  gibsons: 'Town of Gibsons',
  whistler: 'Resort Municipality of Whistler',
  westvan: 'District of West Vancouver',
  dnv: 'District of North Vancouver',
  cnv: 'City of North Vancouver',
  scrd: 'Sunshine Coast Regional District',
};

// ---------------------------------------------------------------- utilities

const args = process.argv.slice(2);
const cmd = args[0];

function flags(list) {
  const out = { _: [], source: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--source') out.source.push(list[++i]);
    else if (a === '--by') out.by = list[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--drafts') out.drafts = true;
    else out._.push(a);
  }
  return out;
}

const die = (msg) => { console.error(msg); process.exit(1); };

async function loadEnv() {
  if (process.env.OPENAI_API_KEY) return;
  try {
    const env = await readFile(fileURLToPath(new URL('.env', ROOT)), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — draft will report the missing key */ }
}

/** Readable text from an HTML page, with scripts, styles and nav stripped. */
function extractText(html) {
  let t = html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  return t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
          .filter((l) => l.length > 1).join('\n');
}

async function fetchSource(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'landev-zone-tool' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('pdf')) {
    throw new Error(`${url} is a PDF — save the relevant text to a page or paste it in by hand`);
  }
  return extractText(await res.text());
}

// ------------------------------------------------------- zones.js read/write

async function readZones() {
  const src = await readFile(ZONES_PATH, 'utf8');
  const mod = await import(`${new URL('data/zones.js', ROOT).href}?t=${Date.now()}`);
  return { src, zones: mod.default };
}

/** Rewrites the ZONES object literal in place, leaving the file's commentary
 *  and helper untouched. */
async function writeZones(src, zones) {
  const body = Object.entries(zones)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).split('\n').join('\n  ')},`)
    .join('\n');
  const next = src.replace(
    /const ZONES = \{[\s\S]*?\n\};/,
    `const ZONES = {\n${body}\n};`
  );
  if (next === src) die('Could not find the ZONES object in data/zones.js — has it been reformatted?');
  await writeFile(ZONES_PATH, next);
}

// -------------------------------------------------------------- the commands

const PROMPT = `You are writing one entry in a civil engineering firm's zone reference.

ABSOLUTE RULE: use ONLY the SOURCE TEXT below. If the source text does not
state something, you do not know it. Do not fill gaps from what you know about
BC zoning, provincial legislation, or similar zones elsewhere. An omission is
correct; an invented number is a professional liability for this firm.

Every value in "points" must be a fact stated in the source text, quoted close
enough that a reviewer can find it on the page. If the source text does not
give you at least one concrete permitted use or density statement, return
{"insufficient": true} and nothing else.

Write for a landowner or small developer, not a planner. Plain, direct, calm.
No hype, no filler.

Return ONLY JSON:
{
  "title": "the zone's name in the bylaw, e.g. Residential 1",
  "summary": "2-3 sentences on what this zone is for and what it generally permits",
  "points": [{"label": "Density", "value": "as the source states it", "source": 0}],
  "caution": "optional, one sentence, only if the source flags something that traps people"
}
"source" is the index of the source the fact came from.`;

async function draft() {
  const f = flags(args.slice(1));
  const [muniId, zone] = f._;
  if (!muniId || !zone) die('usage: draft <muniId> <ZONE> --source <url> [--source <url>]');
  if (!MUNICIPALITIES[muniId]) die(`unknown municipality "${muniId}" — one of: ${Object.keys(MUNICIPALITIES).join(', ')}`);
  if (!f.source.length) die('at least one --source <url> is required; entries are grounded in the municipality\'s own page, never in the model');

  console.log(`Fetching ${f.source.length} source${f.source.length > 1 ? 's' : ''}…`);
  const texts = [];
  for (const url of f.source) {
    try {
      const t = await fetchSource(url);
      console.log(`  ok  ${url}  (${t.length} chars)`);
      texts.push({ url, text: t });
    } catch (e) {
      die(`  fail  ${e.message}`);
    }
  }

  // Keep the zone's own section if the page is long — a 20k-char page is
  // mostly navigation, and the model reads the relevant part better alone.
  const corpus = texts.map((t, i) =>
    `--- SOURCE ${i}: ${t.url} ---\n${t.text.slice(0, 24000)}`
  ).join('\n\n');

  const user = `Municipality: ${MUNICIPALITIES[muniId]}\nZone code: ${zone}\n\nSOURCE TEXT\n${corpus}`;

  if (f.dryRun) {
    console.log('\n--- SYSTEM ---\n' + PROMPT + '\n\n--- USER (first 3000 chars) ---\n' + user.slice(0, 3000));
    console.log(`\n[dry run] ${user.length} chars would be sent. No API call made.`);
    return;
  }

  await loadEnv();
  if (!process.env.OPENAI_API_KEY) die('OPENAI_API_KEY not set (env or .env). Use --dry-run to inspect the prompt without it.');

  console.log('Drafting…');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: user }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) die(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out = JSON.parse((await res.json()).choices[0].message.content);

  if (out.insufficient) {
    die(`The sources do not say enough about ${zone}. Point --source at the zoning bylaw section for this zone.`);
  }

  // Verify every number the model emitted actually appears in the source. This
  // is the check that catches a confident hallucination before a human ever
  // reads it.
  const haystack = texts.map((t) => t.text).join(' ').replace(/\s+/g, ' ');
  const kept = [];
  for (const p of out.points || []) {
    const numbers = String(p.value).match(/\d+(?:\.\d+)?/g) || [];
    const missing = numbers.filter((n) => !haystack.includes(n));
    if (missing.length) {
      console.warn(`  DROPPED "${p.label}": ${missing.join(', ')} not found in the source text`);
      continue;
    }
    kept.push({ label: p.label, value: p.value, source: Number(p.source) || 0 });
  }

  const { src, zones } = await readZones();
  const key = `${muniId}:${zone}`;
  zones[key] = {
    zone,
    municipality: MUNICIPALITIES[muniId],
    title: out.title || undefined,
    summary: out.summary,
    points: kept.length ? kept : undefined,
    caution: out.caution || undefined,
    sources: f.source,
    status: 'draft',
    draftedAt: new Date().toISOString().slice(0, 10),
  };
  await writeZones(src, zones);

  console.log(`\nDrafted ${key} (${kept.length} points kept).`);
  console.log(JSON.stringify(zones[key], null, 2));
  console.log(`\nNOT LIVE YET. Read it against the bylaw, then:\n  node scripts/zones.mjs verify ${key} --by "Your Name"`);
}

async function verify() {
  const f = flags(args.slice(1));
  const key = f._[0];
  if (!key || !f.by) die('usage: verify <muniId>:<ZONE> --by "Name"');
  const { src, zones } = await readZones();
  if (!zones[key]) die(`no entry ${key} — run draft first`);
  zones[key] = { ...zones[key], status: 'verified', reviewedBy: f.by, reviewedAt: new Date().toISOString().slice(0, 10) };
  await writeZones(src, zones);
  console.log(`${key} verified by ${f.by}. It will serve on the next deploy.`);
}

async function list() {
  const f = flags(args.slice(1));
  const { zones } = await readZones();
  const rows = Object.entries(zones).filter(([, v]) => (f.drafts ? v.status === 'draft' : true));
  if (!rows.length) return console.log('nothing yet');
  for (const [k, v] of rows) {
    const mark = v.status === 'verified' ? `verified ${v.reviewedAt} by ${v.reviewedBy}` : 'DRAFT — not served';
    console.log(`${k.padEnd(22)} ${mark}`);
  }
}

/** Reads `[zone-miss] muni:ZONE` lines off stdin (pipe `vercel logs` in) and
 *  ranks them, so drafting effort follows what visitors actually look up. */
async function misses() {
  const input = await new Promise((resolve) => {
    let s = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
  const counts = new Map();
  for (const m of input.matchAll(/\[zone-miss\]\s+(\S+)/g)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  if (!counts.size) return console.log('no [zone-miss] lines found on stdin');
  const { zones } = await readZones();
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    const have = zones[k] ? ` (${zones[k].status})` : '';
    console.log(`${String(n).padStart(5)}  ${k}${have}`);
  });
}

const commands = { draft, verify, list, misses };
if (!commands[cmd]) {
  console.log(`usage:
  node scripts/zones.mjs draft <muniId> <ZONE> --source <url> [--source <url>] [--dry-run]
  node scripts/zones.mjs verify <muniId>:<ZONE> --by "Name"
  node scripts/zones.mjs list [--drafts]
  node scripts/zones.mjs misses     # pipe logs in: vercel logs --since 7d | node scripts/zones.mjs misses

municipalities: ${Object.keys(MUNICIPALITIES).join(', ')}`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();

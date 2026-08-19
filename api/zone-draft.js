// Vercel Serverless Function — draft a zone entry, server-side.
//
// GET /api/zone-draft?token=<ZONE_DRAFT_TOKEN>&muni=squamish&zone=RM-1
//
// This exists so nobody has to set up a local environment to research a zone.
// The Gemini key stays in the Vercel project and never leaves it; the endpoint
// returns the drafted JSON for review and writes nothing.
//
// It deliberately does NOT publish. A draft still has to be pasted into
// data/zones.js and marked verified by a person before the site serves it —
// see the reasoning at the top of that file.
//
// Env vars (both required, or the endpoint stays switched off):
//   GEMINI_API_KEY    — https://aistudio.google.com/apikey
//   ZONE_DRAFT_TOKEN  — any long random string you choose; without it the
//                       endpoint is a free way for strangers to spend your
//                       Gemini quota.
//
// Optional:
//   GEMINI_MODEL      — defaults to gemini-3.6-flash.

// Google retires model ids without much notice — 2.5-flash stopped accepting
// new users mid-2026 — so this is overridable from the dashboard rather than
// being a code change.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

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

/** Hosts we treat as authoritative. A number sourced only outside this list
 *  gets flagged rather than trusted. */
const OFFICIAL = /squamish\.ca|scrd\.ca|sechelt\.ca|gibsons\.ca|whistler\.ca|dnv\.org|westvancouver\.ca|cnv\.org|civicweb|gov\.bc\.ca/i;

const promptFor = (muni, zone) => `You are researching one zone for a civil
engineering firm's reference, for landowners in British Columbia.

Research the ${zone} zone in ${muni}, BC, using Google Search.

SOURCE RULES — these matter more than completeness:
- Prefer the municipality's own website and its zoning bylaw above everything.
- News articles, real estate blogs, and other firms' summaries are NOT
  acceptable for a number. They routinely paraphrase a bylaw wrongly, and a
  wrong setback published by this firm is a professional liability.
- If a figure appears only on a third-party site and you cannot confirm it on
  the municipality's own material, LEAVE IT OUT. An omission is correct; a
  laundered number is not.
- BC zoning changed materially in 2024 under Bill 44 (small-scale multi-unit
  housing). Make sure what you report is current, not superseded.

Write for a landowner or small developer. Plain, direct, calm. No hype.

Return ONLY JSON, no markdown fence:
{
  "title": "the zone's name in the bylaw",
  "summary": "2-3 sentences: what this zone is for and what it generally permits",
  "points": [{"label": "Permitted forms", "value": "as the bylaw states it"}],
  "caution": "optional single sentence about a trap in this zone",
  "confidence": "high | medium | low — how well the municipality's own sources covered this",
  "gaps": ["anything a reviewer must confirm in the bylaw directly"]
}`;

/** Constant-time-ish compare so the token can't be guessed a character at a
 *  time from response timing. */
function tokenOk(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  const expected = process.env.ZONE_DRAFT_TOKEN;
  const key = process.env.GEMINI_API_KEY;

  // Inert until both are configured, and indistinguishable from a wrong token
  // so its existence isn't advertised.
  if (!expected || !key || !tokenOk(String(req.query?.token || ''), expected)) {
    return res.status(404).json({ error: 'not found' });
  }

  const muniId = String(req.query?.muni || '').trim();
  const zone = String(req.query?.zone || '').trim();
  const muni = MUNICIPALITIES[muniId];
  if (!muni) {
    return res.status(400).json({ error: 'unknown muni', known: Object.keys(MUNICIPALITIES) });
  }
  if (!zone) return res.status(400).json({ error: 'zone required, e.g. &zone=RM-1' });

  // &mode=plain drops the search tool, purely to tell quota errors apart:
  // Google meters grounded requests separately, so if a draft 429s but plain
  // does not, the key and model are fine and it is Search grounding that needs
  // a billed plan. Plain mode is a diagnostic only — the prompt tells the
  // model to research with Google Search, so without the tool it reasonably
  // ends in MALFORMED_FUNCTION_CALL. A quota error, or its absence, is the
  // signal here; the answer is not.
  const grounded = String(req.query?.mode || '') !== 'plain';

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptFor(muni, zone) }] }],
          ...(grounded ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
        }),
      }
    );

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 500);
      console.error('gemini error:', detail);
      // Surface Google's own message — it is usually the actionable part
      // (quota, grounding not enabled, bad key).
      return res.status(502).json({ error: 'gemini rejected the request', grounded, model: MODEL, detail });
    }

    const data = await upstream.json();
    const cand = data.candidates?.[0];
    // Gemini 3.x is a thinking model: it returns reasoning parts alongside the
    // answer, marked `thought`. Concatenating everything yields the model's
    // private reasoning; taking only unmarked parts yields the answer.
    const text = (cand?.content?.parts || [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    if (!text) {
      return res.status(502).json({
        error: 'no answer text returned',
        finishReason: cand?.finishReason || null,
        // Thinking-only output usually means it ran out of room before
        // answering, so surface the budget alongside.
        usage: data.usageMetadata || null,
      });
    }

    let out;
    try {
      out = JSON.parse(text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim());
    } catch {
      return res.status(502).json({ error: 'could not parse model JSON', text: text.slice(0, 800) });
    }

    // &debug=1 reports the response shape rather than the entry. Grounding
    // metadata has moved between fields across Gemini versions, and a silently
    // ungrounded answer is the one failure this tool must not ship.
    if (String(req.query?.debug || '') === '1') {
      const gm = cand?.groundingMetadata || null;
      return res.status(200).json({
        model: MODEL,
        candidateKeys: Object.keys(cand || {}),
        groundingMetadataKeys: gm ? Object.keys(gm) : null,
        webSearchQueries: gm?.webSearchQueries || null,
        chunkCount: gm?.groundingChunks?.length ?? null,
        firstChunk: gm?.groundingChunks?.[0] || null,
        citationKeys: cand?.citationMetadata ? Object.keys(cand.citationMetadata) : null,
        finishReason: cand?.finishReason,
        usage: data.usageMetadata || null,
      });
    }

    const chunks = cand?.groundingMetadata?.groundingChunks || [];
    const sources = [...new Set(chunks.map((c) => c.web?.uri).filter(Boolean))];
    const titles = [...new Set(chunks.map((c) => c.web?.title).filter(Boolean))];
    const officialSources = sources.filter((u) => OFFICIAL.test(u));

    // Ready to paste into data/zones.js. Always `draft` — publishing is a
    // human decision, not something an endpoint gets to make.
    const entry = {
      zone,
      municipality: muni,
      title: out.title || undefined,
      summary: out.summary,
      points: (out.points || []).map((p) => ({ label: p.label, value: p.value })),
      caution: out.caution || undefined,
      sources,
      status: 'draft',
      draftedAt: new Date().toISOString().slice(0, 10),
      draftedBy: `${MODEL} + google search`,
      confidence: out.confidence || undefined,
      gaps: out.gaps?.length ? out.gaps : undefined,
    };

    return res.status(200).json({
      key: `${muniId}:${zone}`,
      entry,
      review: {
        groundedOn: sources.length,
        officialSources: officialSources.length,
        // The single most useful signal for whoever reviews this.
        warning: officialSources.length
          ? null
          : 'None of the grounding sources look like a municipal or provincial site. Treat every figure as unconfirmed.',
        sourceTitles: titles.slice(0, 10),
        confidence: out.confidence || null,
        mustConfirm: out.gaps || [],
      },
      next: 'Paste `entry` into data/zones.js under `key`, check each point against the sources, then run: node scripts/zones.mjs verify <key> --by "Name"',
    });
  } catch (err) {
    console.error('zone-draft failed:', err);
    return res.status(502).json({ error: 'draft failed' });
  }
}

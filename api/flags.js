// Vercel Serverless Function — "what's flagged on this parcel"
//
// POST /api/flags
//   { pid, lng, lat, muniId, areaSqm, zoningCode, parcelClass, intent,
//     name, email, phone }
//
// Runs after the visitor has seen the free parcel card and asked for more.
// Two jobs: capture the lead, and return the constraints we can actually
// evidence for that lot.
//
// Everything in `facts` comes from a public dataset and is checkable. Anything
// judgement-based sits in `considerations`, phrased as what usually governs —
// never as a claim about this parcel's bylaw. Nothing here invents a setback,
// a minimum lot size, or a fee.
//
// Optional env var:
//   LEAD_WEBHOOK_URL — if set, each lead is POSTed there as JSON (Zapier,
//   Make, HubSpot, an internal endpoint). Without it leads appear in the
//   Vercel function logs only.

const SCRD = 'https://maps.scrd.ca/arcgis/rest/services';
const SQUAMISH = 'https://services.arcgis.com/YCM10gnCAvCoAhpj/arcgis/rest/services';
const SECHELT = 'https://services5.arcgis.com/rmOn23WtB0tm69No/arcgis/rest/services';
const ALR_WFS = 'https://openmaps.gov.bc.ca/geo/pub/WHSE_LEGAL_ADMIN_BOUNDARIES.OATS_ALR_POLYS/ows';

/**
 * Municipal development-application layers, normalised onto one shape.
 * Only these three publish a public applications service; elsewhere the
 * permit-history flag is simply absent rather than wrong.
 */
const APPLICATIONS = {
  squamish: {
    url: `${SQUAMISH}/Development_Applications(b46f52b07f534963ab5104e68c834de7)/FeatureServer/0`,
    fields: 'Project_Name,Application_Type,Application_File_Number,Application_Date,Application_Details,Applicant,Status,Address',
    source: 'District of Squamish',
    read: (p) => ({
      title: p.Project_Name, type: p.Application_Type, file: p.Application_File_Number,
      status: p.Status, applicant: p.Applicant, detail: p.Application_Details, date: p.Application_Date,
    }),
  },
  sechelt: {
    url: `${SECHELT}/Dev_tracker_List_test/FeatureServer/17`,
    fields: 'CASE_NUMBER,PROJECT_NAME,APPLICANT,PROJECT_DESC,LOCATION,SUB_TYPE_DESC,STATUS_DESC,DATE_ACCEPTED',
    source: 'District of Sechelt',
    read: (p) => ({
      title: p.PROJECT_NAME, type: p.SUB_TYPE_DESC, file: p.CASE_NUMBER,
      status: p.STATUS_DESC, applicant: p.APPLICANT, detail: p.PROJECT_DESC, date: p.DATE_ACCEPTED,
    }),
  },
  scrd: {
    url: `${SCRD}/mySCRDpub_PlanningDashboard/FeatureServer/0`,
    fields: 'FULL_ADDRESS,FOLDER_NUMBER,TYPE,PURPOSE,STATUS,APP_DATE,PID',
    source: 'SCRD',
    read: (p) => ({
      title: p.PURPOSE, type: p.TYPE, file: p.FOLDER_NUMBER,
      status: p.STATUS, applicant: null, detail: p.FULL_ADDRESS, date: p.APP_DATE,
    }),
  },
};

const INTENTS = {
  units: {
    label: 'Add units or a suite',
    service: 'Multiplex & Infill Development',
    considerations: [
      'Provincial small-scale multi-unit housing rules changed what most single-family lots in BC municipalities can carry. What a lot is zoned for and what it can actually be serviced for are different questions, and the second one is usually the binding constraint.',
      'Servicing capacity is the common stopper. The existing water main and sanitary connection were sized for one house; three or four units often triggers a capacity check before a building permit is accepted.',
      'Off-site works — frontage upgrades, a new service connection, sometimes hydrant spacing — are the most frequent cost surprise at higher unit counts, and they are rarely visible until the servicing review.',
    ],
  },
  subdivide: {
    label: 'Subdivide this lot',
    service: 'Subdivision Services',
    considerations: [
      'Minimum lot size and frontage in the current zone govern whether the lot can be split at all. Those come from the zoning bylaw for this specific zone — Landev confirms them against the current text rather than assuming.',
      'Each new lot needs its own servicing. Extending water, sanitary and storm to a new lot line, plus any road dedication, is normally the bulk of the engineering cost.',
      'Subdivision runs through approval as a formal application, so the review cycle — not the design work — usually sets the timeline.',
    ],
  },
  build: {
    label: 'Build on it',
    service: 'Site Servicing',
    considerations: [
      'The servicing design — water, storm and sanitary from the main to the building — is normally the civil scope, and its size depends on what the existing infrastructure at the frontage can carry.',
      'On-site stormwater detention sized to the municipal standard is expected on most new builds. Whether a fuller stormwater study is triggered depends on the site and the receiving system.',
      'If the site is steep, near a watercourse, or on an aquifer, geotechnical and environmental input joins the civil scope and moves both cost and schedule.',
    ],
  },
  other: {
    label: 'Something else',
    service: 'Development Management',
    // No assumption about the work, so these are the checks that apply to any
    // civil scope. What they actually typed rides along on the lead.
    considerations: [
      'Whatever the plan is, the binding constraint is usually servicing rather than zoning — what the existing water, sanitary and storm infrastructure at the frontage can carry decides more than the zone does.',
      'The approving authority and the permit path shape the schedule more than the design work. Knowing which application you are in front of, and what it requires up front, is what prevents a restart halfway through.',
      'Site conditions — slope, watercourses, aquifer, flood — pull geotechnical and environmental work into the scope, and they are cheaper to establish now than after a design exists.',
    ],
  },
  buying: {
    label: 'Considering buying it',
    service: 'Development Management',
    considerations: [
      'The gap between what a lot is zoned for and what it can be serviced for is where most purchase assumptions break. Confirming servicing capacity before removing conditions is the single highest-value check.',
      'Title matters as much as zoning: covenants, statutory rights-of-way and easements can restrict buildable area in ways the zoning map does not show.',
      'Any permit history on the parcel is worth reading closely. A previously refused application usually signals a constraint that has not gone away.',
    ],
  },
};

const withTimeout = async (url, opts = {}, ms = 12000) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** Applications whose status still reads as moving. Each municipality spells
 *  these differently, so match loosely and treat unknown as not-active. */
const isLive = (status) =>
  /active|in.?progress|received|under review|accepted|pending|holdback|submitted/i.test(status || '');

async function fetchApplications(muniId, lng, lat) {
  const layer = APPLICATIONS[muniId];
  if (!layer) return { supported: false, items: [] };
  const params = new URLSearchParams({
    where: '1=1',
    outFields: layer.fields,
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: 'false',
    f: 'geojson',
  });
  try {
    const res = await withTimeout(`${layer.url}/query?${params}`);
    if (!res.ok) return { supported: true, items: [], error: true };
    const data = await res.json();
    if (data?.error) return { supported: true, items: [], error: true };
    const clean = (v) => {
      const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
      return s && s !== 'null' ? s : null;
    };
    const items = (data.features || []).map((f) => {
      const r = layer.read(f.properties || {});
      return {
        title: clean(r.title), type: clean(r.type), file: clean(r.file),
        status: clean(r.status), applicant: clean(r.applicant), detail: clean(r.detail),
        live: isLive(r.status),
      };
    }).filter((r) => r.title || r.file);
    // Live applications first — they are the ones that change what you can do.
    items.sort((a, b) => Number(b.live) - Number(a.live));
    return { supported: true, items, source: layer.source };
  } catch {
    return { supported: true, items: [], error: true };
  }
}

async function inALR(lng, lat) {
  const d = 0.00002;
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    typeNames: 'pub:WHSE_LEGAL_ADMIN_BOUNDARIES.OATS_ALR_POLYS',
    outputFormat: 'application/json', srsName: 'EPSG:4326',
    propertyName: 'ALR_POLY_ID,STATUS', count: '1',
    CQL_FILTER: `BBOX(GEOMETRY,${lng - d},${lat - d},${lng + d},${lat + d},'EPSG:4326')`,
  });
  try {
    const res = await withTimeout(`${ALR_WFS}?${params}`);
    if (!res.ok) return null;
    return ((await res.json())?.features || []).length > 0 ? true : null;
  } catch {
    // Only ever report ALR positively — a failed query must not become a
    // confident "not in the ALR".
    return null;
  }
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());

/** Municipality labels as /api/parcel prints them, so a client that somehow
 *  posts without muniId — a stale cached parcel response, say — still gets
 *  its permit history rather than silently losing that whole section. */
const MUNI_BY_LABEL = {
  'district of squamish': 'squamish',
  'district of sechelt': 'sechelt',
  'town of gibsons': 'gibsons',
  'resort municipality of whistler': 'whistler',
  'district of west vancouver': 'westvan',
  'district of north vancouver': 'dnv',
  'city of north vancouver': 'cnv',
  'sunshine coast regional district': 'scrd',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  const phone = String(b.phone || '').trim();
  const intentKey = String(b.intent || '').trim();
  const intent = INTENTS[intentKey];
  // Free text, only meaningful for "Something else". Capped so a paste can't
  // bloat the lead record.
  const intentText = String(b.intentText || '').trim().slice(0, 400);

  if (!name) return res.status(400).json({ error: 'name required', field: 'name' });
  if (!isEmail(email)) return res.status(400).json({ error: 'valid email required', field: 'email' });
  if (!intent) return res.status(400).json({ error: 'intent required', field: 'intent' });
  if (intentKey === 'other' && !intentText) {
    return res.status(400).json({ error: 'tell us what you have in mind', field: 'intentText' });
  }

  const lng = Number(b.lng);
  const lat = Number(b.lat);
  const hasPoint = Number.isFinite(lng) && Number.isFinite(lat);
  const muniId =
    String(b.muniId || '') ||
    MUNI_BY_LABEL[String(b.municipality || '').trim().toLowerCase()] ||
    '';

  const lead = {
    at: new Date().toISOString(),
    name, email, phone: phone || null,
    intent: intentKey,
    intentLabel: intent.label,
    intentText: intentText || null,
    service: intent.service,
    parcel: {
      pid: b.pid || null,
      address: b.address || null,
      municipality: b.municipality || null,
      areaSqm: Number(b.areaSqm) || null,
      zoning: b.zoningCode || null,
    },
  };

  // Structured so it can be grepped straight out of the Vercel logs until a
  // real store is wired up.
  console.log('[lead]', JSON.stringify(lead));

  if (process.env.LEAD_WEBHOOK_URL) {
    // Never let a webhook outage cost the visitor their answer.
    withTimeout(process.env.LEAD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    }, 5000).catch((e) => console.error('[lead] webhook failed:', e?.message));
  }

  try {
    const [apps, alr] = hasPoint
      ? await Promise.all([fetchApplications(muniId, lng, lat), inALR(lng, lat)])
      : [{ supported: false, items: [] }, null];

    // Facts — each one traceable to a dataset.
    const facts = [];

    const live = apps.items.filter((a) => a.live);
    const past = apps.items.filter((a) => !a.live);

    if (live.length) {
      facts.push({
        level: 'alert',
        title: live.length === 1 ? 'An application is open on this parcel' : `${live.length} applications are open on this parcel`,
        body: 'Anything you file will land alongside it, and a file already in review can constrain what the municipality will accept next.',
      });
    }
    if (past.some((a) => /denied|refus|reject/i.test(a.status || ''))) {
      facts.push({
        level: 'alert',
        title: 'A previous application here was refused',
        body: 'Worth understanding why before repeating the approach — the constraint behind a refusal rarely disappears on its own.',
      });
    }
    if (!live.length && past.length) {
      facts.push({
        level: 'note',
        title: 'This parcel has permit history',
        body: 'Earlier applications tell you what the municipality has already accepted or turned down here.',
      });
    }
    if (apps.supported && !apps.items.length) {
      facts.push({
        level: 'ok',
        title: 'No development applications on record',
        body: `Nothing filed on this parcel in the ${apps.source} tracker.`,
      });
    }
    if (alr) {
      facts.push({
        level: 'alert',
        title: 'Inside the Agricultural Land Reserve',
        body: 'Non-farm use, subdivision and most development need Agricultural Land Commission approval on top of the municipal process. This governs before zoning does.',
      });
    }
    if (/strata/i.test(String(b.parcelClass || ''))) {
      facts.push({
        level: 'note',
        title: 'This is a strata parcel',
        body: 'Work here runs through the strata corporation as well as the municipality, and the common property boundary decides what you control.',
      });
    }
    if (!b.zoningCode) {
      facts.push({
        level: 'note',
        title: 'Zoning is not published as open data here',
        body: 'This municipality has no public zoning service, so the zone has to be confirmed against the bylaw directly. Landev does this as a matter of course.',
      });
    }

    return res.status(200).json({
      ok: true,
      intent: { key: intentKey, label: intent.label, service: intent.service, text: intentText || null },
      facts,
      considerations: intent.considerations,
      applications: {
        supported: apps.supported,
        source: apps.source || null,
        items: apps.items.slice(0, 6),
        truncated: Math.max(0, apps.items.length - 6),
      },
      disclaimer:
        'Preliminary, from public records — not a site investigation or an engineering opinion. Landev confirms zoning, servicing capacity and title against current sources before anything is relied on.',
    });
  } catch (err) {
    console.error('flags failed:', err);
    // The lead is already captured; never fail the whole request over the
    // enrichment step.
    return res.status(200).json({
      ok: true,
      intent: { key: intentKey, label: intent.label, service: intent.service },
      facts: [],
      considerations: intent.considerations,
      applications: { supported: false, items: [], truncated: 0 },
      disclaimer: 'Preliminary, from public records. Some public records could not be reached just now.',
    });
  }
}

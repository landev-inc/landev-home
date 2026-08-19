// Vercel Serverless Function — Landev parcel pre-check
//
// GET /api/parcel?q=<street address or PID>
//
// No API keys. Every source below is public open data:
//   • BC Address Geocoder (province) — address <-> coordinates and locality
//   • ParcelMap BC / PMBC parcel fabric (LTSA, Open Government Licence – BC)
//     — coordinates -> PID, registered plan, parcel class, area, lot geometry
//   • Municipal ArcGIS FeatureServers — coordinates -> zoning
//
// Requests are proxied through here rather than made from the browser because
// none of these send an Access-Control-Allow-Origin header, and because parcel
// boundaries and zoning change on the order of months, so responses cache well.

const GEOCODER = 'https://geocoder.api.gov.bc.ca/addresses.json';
const REVERSE = 'https://geocoder.api.gov.bc.ca/sites/nearest.json';
const PMBC_WFS = 'https://openmaps.gov.bc.ca/geo/pub/WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW/ows';
const PMBC_TYPE = 'pub:WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW';
const PMBC_FIELDS = [
  'PID_FORMATTED',
  'PARCEL_NAME',
  'PLAN_NUMBER',
  'PARCEL_CLASS',
  'PARCEL_STATUS',
  'OWNER_TYPE',
  'MUNICIPALITY',
  'FEATURE_AREA_SQM',
  'SHAPE',
].join(',');

// Parcel boundaries and zoning move slowly; a long shared cache keeps the
// upstream open-data servers unbothered by repeat lookups of the same lot.
const CACHE_SECONDS = 60 * 60 * 6;

const SQUAMISH = 'https://services.arcgis.com/YCM10gnCAvCoAhpj/arcgis/rest/services';
const SCRD = 'https://maps.scrd.ca/arcgis/rest/services';
const RMOW = 'https://services7.arcgis.com/gENeutiVOvqS3PuS/arcgis/rest/services';
const DNV = 'https://geoweb.dnv.org/arcgis/rest/services';

/**
 * The communities Landev serves, each with the names the two upstream sources
 * call it by.
 *
 * `locality` is what the BC Geocoder returns and is the primary key, because
 * PMBC's own MUNICIPALITY column is unreliable on strata and air-space
 * records — a West Vancouver strata lot reports "Rural", which would route it
 * to the wrong region and the wrong zoning service. `pmbc` is the fallback.
 */
const MUNICIPALITIES = [
  { id: 'squamish', label: 'District of Squamish', region: 'Sea-to-Sky', office: 'Squamish',
    locality: ['Squamish'], pmbc: ['Squamish, District of'] },
  { id: 'whistler', label: 'Resort Municipality of Whistler', region: 'Sea-to-Sky', office: 'Squamish',
    locality: ['Whistler'], pmbc: ['Whistler, Resort Municipality of'] },
  { id: 'gibsons', label: 'Town of Gibsons', region: 'Sunshine Coast', office: 'Gibsons',
    locality: ['Gibsons'], pmbc: ['Gibsons, Town of'] },
  { id: 'sechelt', label: 'District of Sechelt', region: 'Sunshine Coast', office: 'Gibsons',
    locality: ['Sechelt', 'District of Sechelt'], pmbc: ['Sechelt, District of'] },
  { id: 'westvan', label: 'District of West Vancouver', region: 'North Shore', office: 'West Vancouver',
    locality: ['West Vancouver'], pmbc: ['West Vancouver, The Corporation of the District of'] },
  { id: 'dnv', label: 'District of North Vancouver', region: 'North Shore', office: 'West Vancouver',
    locality: ['District of North Vancouver'], pmbc: ['North Vancouver, District of'] },
  { id: 'cnv', label: 'City of North Vancouver', region: 'North Shore', office: 'West Vancouver',
    locality: ['City of North Vancouver'], pmbc: ['North Vancouver, City of'] },
  // Electoral areas — Roberts Creek, Halfmoon Bay, Egmont and the rest. PMBC
  // labels them all "Rural" and the geocoder returns the community name, so
  // this is reached by fallback rather than by an exhaustive locality list.
  { id: 'scrd', label: 'Sunshine Coast Regional District', region: 'Sunshine Coast', office: 'Gibsons',
    locality: [], pmbc: ['Rural'] },
];

/**
 * Zoning layers by municipality id. Adding a community means adding one entry
 * here plus its names above. `read` maps that layer's columns onto our shape —
 * every municipality names them differently.
 *
 * West Vancouver and the City of North Vancouver publish no publicly reachable
 * zoning service, so they are absent and their parcels return zoning: null.
 */
const ZONING = {
  squamish: {
    url: `${SQUAMISH}/Zoning/FeatureServer/31`,
    fields: 'ZONE_CODE,ZONE_DES,LandUseDesignation,Zoning_Bylaw',
    source: 'District of Squamish',
    read: (p) => ({ code: p.ZONE_CODE, description: p.ZONE_DES, ocp: p.LandUseDesignation, bylaw: p.Zoning_Bylaw }),
  },
  sechelt: {
    url: `${SCRD}/Sechelt/dosPlanning/MapServer/1`,
    fields: 'ZONING,BYLAW_DOC_,ZONING_SIT,OCP_SITE_L',
    source: 'District of Sechelt / SCRD',
    read: (p) => ({ code: p.ZONING, description: null, ocp: p.OCP_SITE_L, bylaw: p.BYLAW_DOC_ }),
  },
  gibsons: {
    url: `${SCRD}/togPlanning_OCPandZoning/MapServer/87`,
    fields: 'ZoningBylawCode,ZoningBylawCode_desc',
    source: 'Town of Gibsons / SCRD',
    read: (p) => ({ code: p.ZoningBylawCode, description: p.ZoningBylawCode_desc, ocp: null, bylaw: null }),
  },
  whistler: {
    url: `${RMOW}/Zoning_Designations/FeatureServer/2`,
    fields: 'ZONING',
    source: 'Resort Municipality of Whistler',
    read: (p) => ({ code: p.ZONING, description: null, ocp: null, bylaw: null }),
  },
  dnv: {
    url: `${DNV}/Data_DynamicLayers_Zoning/MapServer/0`,
    fields: 'Zoning',
    source: 'District of North Vancouver',
    read: (p) => ({ code: p.Zoning, description: null, ocp: null, bylaw: null }),
  },
  scrd: {
    url: `${SCRD}/mySCRDpub_PlanningDevelopment/MapServer/14`,
    fields: 'LANDUSE,SCHEDULE,BYLAW,DESCRIP',
    source: 'SCRD',
    read: (p) => ({ code: p.LANDUSE, description: p.DESCRIP, ocp: p.SCHEDULE, bylaw: p.BYLAW }),
  },
};

/** Locality wins; PMBC's municipality is the fallback for PID-only lookups. */
function resolveMunicipality(locality, pmbcName) {
  const loc = (locality || '').trim();
  const pmbc = (pmbcName || '').trim();
  return (
    MUNICIPALITIES.find((m) => m.locality.some((n) => n.toLowerCase() === loc.toLowerCase())) ||
    MUNICIPALITIES.find((m) => m.pmbc.some((n) => n.toLowerCase() === pmbc.toLowerCase())) ||
    null
  );
}

const withTimeout = async (url, ms = 15000) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Treat the query as a PID only when it is nothing but digits and separators.
 * A bare nine-digit run inside a sentence is far more often a phone number or
 * a file number than a parcel identifier.
 */
function asPid(raw) {
  const q = raw.trim().replace(/^PID[:#\s]*/i, '');
  if (!/^[\d\s-]+$/.test(q)) return null;
  const digits = q.replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

async function wfs(cqlFilter, count = 1) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: PMBC_TYPE,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    propertyName: PMBC_FIELDS,
    count: String(count),
    CQL_FILTER: cqlFilter,
  });
  const res = await withTimeout(`${PMBC_WFS}?${params}`, 20000);
  if (!res.ok) return [];
  return (await res.json())?.features || [];
}

/** Every coordinate ring in a Polygon or MultiPolygon, holes included. */
function ringsOf(geometry) {
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (Array.isArray(node[0]) && typeof node[0][0] === 'number') { out.push(node); return; }
    node.forEach(walk);
  };
  walk(geometry?.coordinates);
  return out;
}

/** Ray casting over every ring at once — an odd number of crossings means
 *  inside, which also makes holes fall out correctly without special cases. */
function containsPoint(geometry, lng, lat) {
  let inside = false;
  for (const ring of ringsOf(geometry)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) &&
          lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-15) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Choose the parcel a geocoded point actually falls on.
 *
 * A tight bbox query returns everything whose *bounding box* clips the box,
 * which on a dense block is dozens of lots. Worse, a strata development stacks
 * many records on one footprint: 6691 Nelson Ave returns 158 strata lots, an
 * air space parcel, and the underlying fee-simple lot, all with identical
 * geometry and area. So test real containment first, then prefer the
 * fee-simple lot — that is the parcel civil work is scoped against — and only
 * then the smallest candidate.
 */
function pickParcel(features, lng, lat) {
  const usable = (features || []).filter((f) => {
    const p = f.properties || {};
    return f.geometry && p.PID_FORMATTED && p.PARCEL_CLASS !== 'Road';
  });
  if (!usable.length) return null;

  const containing = usable.filter((f) => containsPoint(f.geometry, lng, lat));
  const pool = containing.length ? containing : usable;

  // Subdivision is PMBC's class for an ordinary fee-simple lot. Everything
  // else here — Building Strata, Bare Land Strata, Air Space, Interest — is a
  // right layered over one.
  const tier = (p) => (p.PARCEL_CLASS === 'Subdivision' ? 0 : 1);

  return pool.sort((a, b) => {
    const A = a.properties, B = b.properties;
    if (tier(A) !== tier(B)) return tier(A) - tier(B);
    return (A.FEATURE_AREA_SQM || Infinity) - (B.FEATURE_AREA_SQM || Infinity);
  })[0];
}

async function geocode(address) {
  const params = new URLSearchParams({
    addressString: /\bBC\b/i.test(address) ? address : `${address}, BC`,
    maxResults: '1',
    outputSRS: '4326',
  });
  const res = await withTimeout(`${GEOCODER}?${params}`);
  if (!res.ok) return null;
  const hit = (await res.json())?.features?.[0];
  const coords = hit?.geometry?.coordinates;
  if (!Array.isArray(coords)) return null;
  const p = hit.properties || {};
  if (Number(p.score ?? 0) < 60) return null;
  return {
    lng: coords[0],
    lat: coords[1],
    label: String(p.fullAddress || address),
    precision: String(p.matchPrecision || ''),
    locality: p.localityName ? String(p.localityName) : null,
  };
}

/** Locality for a PID lookup, where no address was supplied to begin with. */
async function localityAt(lng, lat) {
  try {
    const res = await withTimeout(`${REVERSE}?point=${lng},${lat}&outputSRS=4326`, 8000);
    if (!res.ok) return null;
    const p = (await res.json())?.properties || {};
    return p.localityName ? String(p.localityName) : null;
  } catch {
    return null;
  }
}

/** Centre and extent of the parcel's bounding box — correct for the concave
 *  waterfront lots a naive centroid mishandles. */
function bounds(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      minX = Math.min(minX, node[0]); maxX = Math.max(maxX, node[0]);
      minY = Math.min(minY, node[1]); maxY = Math.max(maxY, node[1]);
      return;
    }
    node.forEach(walk);
  };
  walk(geometry?.coordinates);
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };
}

async function lookupZoning(muni, lng, lat) {
  const layer = muni && ZONING[muni.id];
  if (!layer) return null;
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
    if (!res.ok) return null;
    const data = await res.json();
    // ArcGIS reports failures as HTTP 200 with an `error` body.
    if (data?.error) return null;
    const props = data?.features?.[0]?.properties;
    if (!props) return null;
    const out = layer.read(props);
    const clean = (v) => {
      const s = v == null ? '' : String(v).trim();
      return s && s !== 'null' ? s : null;
    };
    if (!clean(out.code)) return null;
    return {
      code: clean(out.code),
      description: clean(out.description),
      ocp: clean(out.ocp),
      bylaw: clean(out.bylaw),
      source: layer.source,
    };
  } catch {
    // A municipal server being down must not take the parcel card with it.
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = String(req.query?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const pid = asPid(q);
    let feature = null;
    let matched = null;

    if (pid) {
      feature = (await wfs(`PID='${pid}'`))?.[0] || null;
    } else {
      matched = await geocode(q);
      if (!matched) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ found: false, reason: 'address-not-found', query: q });
      }
      // A ~2m box gathers every parcel near the point; pickParcel decides which
      // one the point is actually on. The count is high because a strata
      // building can produce well over a hundred candidates and the fee-simple
      // lot is not reliably among the first few.
      const d = 0.00002;
      const { lng, lat } = matched;
      feature = pickParcel(
        await wfs(`BBOX(SHAPE,${lng - d},${lat - d},${lng + d},${lat + d},'EPSG:4326')`, 200),
        lng,
        lat
      );
    }

    if (!feature) {
      // The address resolved but sits on a road allowance or unsurveyed land.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        found: false,
        reason: pid ? 'pid-not-found' : 'no-parcel-at-address',
        query: q,
        address: matched?.label || null,
      });
    }

    const p = feature.properties || {};
    const box = bounds(feature.geometry);
    const sqm = Number(p.FEATURE_AREA_SQM) || null;

    const locality = matched?.locality || (box ? await localityAt(box.lng, box.lat) : null);
    const muni = resolveMunicipality(locality, p.MUNICIPALITY);
    const zoning = box ? await lookupZoning(muni, box.lng, box.lat) : null;

    res.setHeader(
      'Cache-Control',
      `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`
    );
    return res.status(200).json({
      found: true,
      query: q,
      address: matched?.label || (p.PID_FORMATTED ? `PID ${p.PID_FORMATTED}` : q),
      matchPrecision: matched?.precision || 'PID',
      approximate: matched ? matched.precision === 'STREET' : false,
      parcel: {
        pid: p.PID_FORMATTED || null,
        planNumber: p.PLAN_NUMBER || null,
        parcelClass: p.PARCEL_CLASS || null,
        status: p.PARCEL_STATUS || null,
        ownerType: p.OWNER_TYPE || null,
        municipality: muni?.label || p.MUNICIPALITY || null,
        areaSqm: sqm,
        areaHa: sqm ? Number((sqm / 10000).toFixed(4)) : null,
        areaSqft: sqm ? Math.round(sqm * 10.7639) : null,
      },
      zoning,
      // Consumed by /api/flags to pick the municipal applications layer.
      municipalityId: muni?.id || null,
      landev: muni ? { region: muni.region, office: muni.office } : null,
      geometry: feature.geometry || null,
      center: box ? { lng: box.lng, lat: box.lat } : null,
      bbox: box ? [box.minX, box.minY, box.maxX, box.maxY] : null,
      sources: [
        'ParcelMap BC (LTSA), Open Government Licence – BC',
        zoning ? `Zoning: ${zoning.source}` : null,
      ].filter(Boolean),
    });
  } catch (err) {
    console.error('parcel lookup failed:', err);
    return res.status(502).json({ error: 'lookup failed' });
  }
}

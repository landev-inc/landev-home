// Vercel Serverless Function — Landev parcel pre-check
//
// GET /api/parcel?q=<street address or PID>
//
// No API keys. Every source below is public open data:
//   • BC Address Geocoder (province) — address -> coordinates
//   • ParcelMap BC / PMBC parcel fabric (LTSA, Open Government Licence – BC)
//     — coordinates -> PID, registered plan, parcel class, area, municipality
//   • Municipal ArcGIS FeatureServers — coordinates -> zoning
//
// Requests are proxied through here rather than made from the browser because
// none of these send an Access-Control-Allow-Origin header, and because parcel
// boundaries and zoning change on the order of months, so responses cache well.

const GEOCODER = 'https://geocoder.api.gov.bc.ca/addresses.json';
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
 * Zoning layers keyed by the MUNICIPALITY string PMBC returns for the parcel.
 * Keying on the parcel's own municipality (rather than asking the visitor
 * which city they're in) is what lets a single address box work across every
 * community Landev serves.
 *
 * `read` maps that layer's attribute names onto our shape — every municipality
 * names these columns differently.
 *
 * Municipalities absent from this table still get the full parcel card; they
 * just have no public zoning service to query. West Vancouver and the City of
 * North Vancouver are in that group.
 */
const ZONING = {
  'Squamish, District of': {
    url: `${SQUAMISH}/Zoning/FeatureServer/31`,
    fields: 'ZONE_CODE,ZONE_DES,LandUseDesignation,Zoning_Bylaw',
    source: 'District of Squamish',
    read: (p) => ({ code: p.ZONE_CODE, description: p.ZONE_DES, ocp: p.LandUseDesignation, bylaw: p.Zoning_Bylaw }),
  },
  'Sechelt, District of': {
    url: `${SCRD}/Sechelt/dosPlanning/MapServer/1`,
    fields: 'ZONING,BYLAW_DOC_,ZONING_SIT,OCP_SITE_L',
    source: 'District of Sechelt / SCRD',
    read: (p) => ({ code: p.ZONING, description: null, ocp: p.OCP_SITE_L, bylaw: p.BYLAW_DOC_ }),
  },
  'Gibsons, Town of': {
    url: `${SCRD}/togPlanning_OCPandZoning/MapServer/87`,
    fields: 'ZoningBylawCode,ZoningBylawCode_desc',
    source: 'Town of Gibsons / SCRD',
    read: (p) => ({ code: p.ZoningBylawCode, description: p.ZoningBylawCode_desc, ocp: null, bylaw: null }),
  },
  'Whistler, Resort Municipality of': {
    url: `${RMOW}/Zoning_Designations/FeatureServer/2`,
    fields: 'ZONING',
    source: 'Resort Municipality of Whistler',
    read: (p) => ({ code: p.ZONING, description: null, ocp: null, bylaw: null }),
  },
  'North Vancouver, District of': {
    url: `${DNV}/Data_DynamicLayers_Zoning/MapServer/0`,
    fields: 'Zoning',
    source: 'District of North Vancouver',
    read: (p) => ({ code: p.Zoning, description: null, ocp: null, bylaw: null }),
  },
  // PMBC labels every electoral area — Roberts Creek, Halfmoon Bay, Egmont and
  // the rest — simply "Rural", with no way to tell SCRD from SLRD. Pointing
  // that at the SCRD layer is safe because the query is spatial: a parcel
  // outside SCRD intersects nothing and comes back with no zoning rather than
  // the wrong zoning.
  Rural: {
    url: `${SCRD}/mySCRDpub_PlanningDevelopment/MapServer/14`,
    fields: 'LANDUSE,SCHEDULE,BYLAW,DESCRIP',
    source: 'SCRD',
    read: (p) => ({ code: p.LANDUSE, description: p.DESCRIP, ocp: p.SCHEDULE, bylaw: p.BYLAW }),
  },
};

/** Which Landev office covers the parcel — shown so the result feels local. */
const REGION = {
  'Squamish, District of': { region: 'Sea-to-Sky', office: 'Squamish' },
  'Whistler, Resort Municipality of': { region: 'Sea-to-Sky', office: 'Squamish' },
  'Gibsons, Town of': { region: 'Sunshine Coast', office: 'Gibsons' },
  'Sechelt, District of': { region: 'Sunshine Coast', office: 'Gibsons' },
  Rural: { region: 'Sunshine Coast', office: 'Gibsons' },
  'West Vancouver, The Corporation of the District of': { region: 'North Shore', office: 'West Vancouver' },
  'North Vancouver, District of': { region: 'North Shore', office: 'West Vancouver' },
  'North Vancouver, City of': { region: 'North Shore', office: 'West Vancouver' },
};

const withTimeout = async (url, ms = 12000) => {
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
  const res = await withTimeout(`${PMBC_WFS}?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.features?.[0] || null;
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
    score: Number(p.score ?? 0),
  };
}

/** Centre of the parcel's bounding box — good enough to place a marker, and
 *  correct for the concave waterfront lots that a naive centroid mishandles. */
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

async function lookupZoning(municipality, lng, lat) {
  const layer = ZONING[municipality];
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
      feature = await wfs(`PID='${pid}'`);
    } else {
      matched = await geocode(q);
      if (!matched) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ found: false, reason: 'address-not-found', query: q });
      }
      // A ~2m box around the point catches the lot under it without needing
      // exact-boundary intersection maths.
      const d = 0.00002;
      const { lng, lat } = matched;
      feature = await wfs(`BBOX(SHAPE,${lng - d},${lat - d},${lng + d},${lat + d},'EPSG:4326')`);
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
    const municipality = String(p.MUNICIPALITY || '').trim();
    const sqm = Number(p.FEATURE_AREA_SQM) || null;

    const zoning = box ? await lookupZoning(municipality, box.lng, box.lat) : null;

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
        municipality: municipality || null,
        areaSqm: sqm,
        areaHa: sqm ? Number((sqm / 10000).toFixed(4)) : null,
        areaSqft: sqm ? Math.round(sqm * 10.7639) : null,
      },
      zoning,
      landev: REGION[municipality] || null,
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

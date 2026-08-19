// Zone knowledge base.
//
// Keyed `<municipalityId>:<ZONE_CODE>` — the same ids /api/parcel returns, and
// the zone code exactly as the municipal layer spells it.
//
// WHY THIS IS A FILE AND NOT AN LLM CALL
// The write-up for a zone is identical for every parcel in it, so there is no
// reason to generate it per visitor — and every reason not to. An ungrounded
// model produces plausible setbacks and parking minimums rather than correct
// ones, and a wrong number on Landev's own site is a professional problem, not
// a UX one. So each entry is drafted from the municipality's own published
// text, reviewed by a person, and then served from here instantly and free.
//
// ONLY `status: 'verified'` ENTRIES ARE SERVED. Drafts sit here until someone
// at Landev has checked them against the bylaw and run:
//
//   node scripts/zones.mjs verify squamish:R-1 --by "Name"
//
// To draft a new one from the municipality's page:
//
//   node scripts/zones.mjs draft squamish R-1 --source https://squamish.ca/...
//
// FIELD NOTES
//   summary   Plain language, 2-3 sentences. What this zone is for.
//   points    The specifics. `source` indexes into `sources`. Every one of
//             these must appear in the cited page — that is what review means.
//   caution   Optional. Shown alongside, for a zone with a known trap.
//   sources   Municipal URLs only. Not a news article, not a blog, not an AI
//             summary — those are how wrong numbers get laundered into
//             looking official.

/** @type {Record<string, {
 *   zone: string, municipality: string, title?: string, summary: string,
 *   points?: {label: string, value: string, source?: number}[],
 *   caution?: string, sources: string[],
 *   status: 'draft' | 'verified', reviewedBy?: string, reviewedAt?: string,
 *   draftedAt?: string
 * }>} */
const ZONES = {
  "squamish:R-1": {
    "zone": "R-1",
    "municipality": "District of Squamish",
    "title": "Residential 1",
    "summary": "The zone that replaced most of Squamish's single-family zones after the province's Bill 44 changes. Any lot in R-1 may build a single unit dwelling, a two-unit dwelling (duplex), or a triplex or fourplex — the small-scale multi-unit forms, without a rezoning.",
    "points": [
      {
        "label": "Permitted forms",
        "value": "Single unit dwelling, two-unit dwelling (duplex), triplex or fourplex",
        "source": 0
      },
      {
        "label": "Units per lot",
        "value": "No more than 5 dwelling units in total — so a fourplex may add one secondary suite, multi-unit flex unit or accessory dwelling unit",
        "source": 0
      },
      {
        "label": "Height",
        "value": "9m for single and two-unit dwellings; 11m or three storeys, whichever is less, for triplex and fourplex",
        "source": 0
      },
      {
        "label": "Lot coverage",
        "value": "33% for a single or two-unit dwelling; 40% with a secondary suite and accessory dwelling unit; 50% for a triplex or fourplex",
        "source": 0
      },
      {
        "label": "Unit size",
        "value": "Each dwelling unit in a triplex or fourplex is capped at 220m² gross floor area",
        "source": 0
      },
      {
        "label": "Floor area ratio",
        "value": "No maximum FAR for triplexes and fourplexes",
        "source": 0
      },
      {
        "label": "Parking",
        "value": "A triplex or fourplex needs at least one space per principal dwelling unit",
        "source": 0
      }
    ],
    "caution": "R-1 is the standard designation. Lots inside flood or debris-flow hazard areas carry R-2 to R-5 instead, which are not the same — check the mapped zone rather than assuming R-1 from the neighbourhood.",
    "sources": [
      "https://squamish.ca/building-and-land-development/home-land-and-property-development/residential-zoning-changes/"
    ],
    "status": "verified",
    "draftedAt": "2026-08-19",
    "reviewedBy": "Otavio Chaves",
    "reviewedAt": "2026-08-19"
  },
  "squamish:RM-1": {
    "zone": "RM-1",
    "municipality": "District of Squamish",
    "title": "Multiple Unit Residential 1",
    "summary": "Squamish's medium-density multi-family zone, governed by Zoning Bylaw No. 2200. It carries townhouse and multi-unit residential forms directly, without the rezoning a single-family zone would need. It is a separate zone from the R-1 to R-5 series the District created in 2024 under Bill 44, and was not replaced by them.",
    "points": [
      {
        "label": "Permitted forms",
        "value": "Multi-unit residential — townhouses and multi-family dwellings",
        "source": 1
      },
      {
        "label": "Rear setback",
        "value": "9.15 m — the largest rear yard requirement of any residential zone in Squamish",
        "source": 0
      },
      {
        "label": "Interior side setback",
        "value": "4.57 m",
        "source": 1
      },
      {
        "label": "Useable open space",
        "value": "40 m² per dwelling unit, with common open space no dimension less than 4.57 m",
        "source": 1
      },
      {
        "label": "Accessory buildings",
        "value": "1.52 m from the side lot line",
        "source": 1
      }
    ],
    "caution": "Provisional summary — the dimensional standards here are drawn from District setback guidance and from the baseline figures cited in Squamish development permit records, not yet from a line-by-line reading of Zoning Bylaw No. 2200. Landev confirms every figure against the current bylaw text before it is relied on. Density, height, lot coverage and parking for RM-1 are not covered here.",
    "sources": [
      "https://squamish.ca/projects-plans-and-initiatives/completed-projects/2022-completed-projects/2020-zoning-bylaw-update/stage3updates/clarification-of-proposed-setback-amendments/",
      "https://squamish.civicweb.net/filepro/documents/11774"
    ],
    "status": "verified",
    "draftedAt": "2026-08-19",
    "reviewedBy": "Otavio Chaves",
    "reviewedAt": "2026-08-19"
  },
};

export default ZONES;

/**
 * The entry for a parcel, or null.
 *
 * Drafts are withheld unless ZONES_PREVIEW_DRAFTS is set, which exists so the
 * team can look at an entry on the real site before signing off on it. A draft
 * served that way carries `unverified: true` and the panel labels it, so a
 * preview can never be mistaken for reviewed content.
 */
export function zoneFor(municipalityId, zoneCode) {
  if (!municipalityId || !zoneCode) return null;
  const entry = ZONES[`${municipalityId}:${String(zoneCode).trim()}`];
  if (!entry) return null;
  if (entry.status !== 'verified' && !process.env.ZONES_PREVIEW_DRAFTS) return null;

  // Only the reader-facing fields go out. `confidence`, `gaps` and `draftedBy`
  // are notes for whoever reviews the entry and have no business on the page.
  const { zone, municipality, title, summary, points, caution, sources, reviewedAt } = entry;
  return {
    zone, municipality, title, summary, points, caution, sources, reviewedAt,
    ...(entry.status === 'verified' ? {} : { unverified: true }),
  };
}

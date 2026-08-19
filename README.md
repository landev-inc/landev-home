# Landev Consulting — Website

Static homepage plus two serverless tools — an **Instant Estimate** chat and a
**Parcel pre-check** — deployed on Vercel.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The whole homepage. Plain, editable HTML. |
| `api/chat.js` | Serverless chat endpoint. The system prompt at the top **is** the conversation design. |
| `api/parcel.js` | Real parcel lookup: address or PID → lot, area, zoning. |
| `server.js` | Local dev server (no dependencies). Runs the static site *and* the API. |
| `images/`, `fonts/`, `js/` | Page assets. `js/script01.js` is the generated `dc-runtime` — do not edit it. |
| `vercel.json` | Routing, CORS, and asset caching. |

The page originally shipped as a single 9.2 MB self-unpacking bundle with every
asset base64-encoded inside it. It has been unpacked into the files above, so the
HTML is now editable directly and the payload is ~84 KB plus real assets.

## Required environment variable

The chat returns an error message until this is set on the Vercel project:

```bash
vercel env add OPENAI_API_KEY production
```

Add it to `preview` and `development` too if you want the chat working there.
For local work, put it in `.env` (already gitignored).

## Editing the conversation

Everything the assistant says, asks, and quotes lives in `SYSTEM_PROMPT` in
`api/chat.js` — the question order, the numbered options, the fee and timeline
reference table, and the closing booking link. Edit that string and redeploy;
no front-end changes are needed.

The fee ranges in there are placeholders drawn from typical civil scopes.
**Replace them with Landev's real numbers before this goes in front of clients.**

## Instant Estimate wiring

Any element carrying `data-estimate-cta` opens the chat — currently the header,
hero, and closing CTA. The handler is delegated, so it keeps working after the
page's runtime re-renders. To add another trigger:

```html
<a href="#instant-estimate" data-estimate-cta="">Instant Estimate</a>
```

The parcel modal's "Book a call about this parcel" is deliberately still a direct
booking link.

## Parcel pre-check

`GET /api/parcel?q=<address or PID>` returns the registered parcel and its
zoning. No API keys — every source is public open data:

| Source | Gives us |
|---|---|
| [BC Address Geocoder](https://geocoder.api.gov.bc.ca) | address → coordinates |
| ParcelMap BC (LTSA cadastre, WFS) | PID, registered plan, parcel class, area, municipality, lot geometry |
| Municipal ArcGIS FeatureServers | zoning code, description, OCP, bylaw |

One address box works across every community Landev serves, so the endpoint has
to work out the municipality itself. It keys on the **geocoder's locality**,
falling back to PMBC's `MUNICIPALITY` column — that order matters, because PMBC
reports `"Rural"` for strata and air-space records, including ones in West
Vancouver. Communities are listed in `MUNICIPALITIES` and their zoning layers in
`ZONING`; adding one means adding an entry to each.

Currently wired: Squamish, Sechelt, Gibsons, Whistler, District of North
Vancouver, and SCRD electoral areas. West Vancouver and the City of North
Vancouver publish no publicly reachable zoning service, so those parcels return
full lot data with `zoning: null` and the card says so rather than guessing.

Zoning failures are deliberately non-fatal — if a municipal server is down, the
parcel card still renders.

### Picking the right parcel

This is the fiddly part, and getting it wrong is not obvious from the output —
it just quietly returns a different lot.

A bbox query returns every parcel whose *bounding box* clips the search box,
which on a dense block is dozens, and on a strata development is hundreds
stacked on one footprint (6691 Nelson Ave returns 158 strata lots, an air space
parcel, and the fee-simple lot beneath, all with identical geometry). Taking the
first result gives an arbitrary one. So `pickParcel`:

1. drops road parcels and records with no PID,
2. keeps only parcels that **actually contain** the point (ray casting, not
   bbox overlap),
3. prefers `PARCEL_CLASS === 'Subdivision'` — the ordinary fee-simple lot civil
   work is scoped against — over strata, air space and interest records,
4. then takes the smallest.

The count is deliberately high (200): the correct lot is often not among the
first few results.

### The map

The result panel draws the true lot outline over Esri World Imagery (free, with
attribution — the same basemap the `land-dev-leads` scraper uses). Both the
imagery request and the polygon are projected to Web Mercator so the outline
lands on the actual boundaries rather than drifting; the padded extent is
adjusted to the image's aspect ratio, without which the export service fits the
bbox its own way and the overlay no longer registers. A failed image load falls
back to the plain dark panel.

"Get an estimate for this parcel" hands the address, PID, area, zoning and
municipality straight to the Instant Estimate chat as an opening message.

## Local development

```bash
node server.js
```

Runs the static site and the API together at http://localhost:8787, so both the
parcel check and the chat work. Put `OPENAI_API_KEY` in `.env` for the chat; the
parcel check needs no key.

## Deploy

```bash
vercel deploy --prod
```

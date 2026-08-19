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

### The lead gate

The panel runs in three stages, all in the same box:

1. **Free** — the parcel card above.
2. **The ask** — "See what's flagged on this parcel" opens a short form: what
   they're trying to do (add units / subdivide / build / considering buying),
   plus name and email required, phone optional.
3. **The reveal** — `POST /api/flags` captures the lead and returns what can
   actually be evidenced for that lot.

`api/flags.js` separates two kinds of content deliberately:

- **`facts`** — each traceable to a public dataset. Open and refused
  development applications, ALR status, strata parcels, missing zoning data.
- **`considerations`** — judgement, written per intent, phrased as what usually
  governs. These never assert a setback, a minimum lot size, or a fee for the
  specific parcel.

The permit history is the reason this gate is worth an email. For 1189 Wilson
Cres it returns four applications including a refused development permit with
all five variances it sought — the kind of thing that changes what a buyer will
pay. Only Squamish, Sechelt and SCRD publish an applications service; elsewhere
the section is absent rather than wrong.

ALR is only ever reported **positively** — a failed query returns null rather
than a confident "not in the ALR".

### Zone write-ups

`data/zones.js` holds a plain-language summary per zone, keyed
`<municipalityId>:<ZONE_CODE>`. When a parcel's zone has a **verified** entry,
it renders at the top of the flagged panel with its source links.

**This is deliberately not an LLM call at request time.** The write-up for a
zone is identical for every parcel in it, so generating it per visitor buys
nothing and costs accuracy: an ungrounded model produces plausible setbacks and
parking minimums rather than correct ones, and a wrong number on Landev's own
site is a professional problem rather than a UX one. Zoning is a particularly
bad case — Squamish replaced RS-1/RS-2/RS-3 with R-1 in 2024 under Bill 44, so
a model reciting training data describes a bylaw that no longer exists.

So: draft from the municipality's own page, have a person check it, serve from
cache forever.

```bash
# grounded on Google Search — finds its own sources and returns them
node scripts/zones.mjs draft squamish RM-1 --gemini

# or point it at a page yourself; the model may use ONLY that text
node scripts/zones.mjs draft squamish R-1 \
  --source https://squamish.ca/building-and-land-development/home-land-and-property-development/residential-zoning-changes/

# see exactly what would be sent, no API call, no key needed
node scripts/zones.mjs draft squamish R-1 --source <url> --dry-run

# after reading it against the bylaw
node scripts/zones.mjs verify squamish:R-1 --by "Your Name"

node scripts/zones.mjs list --drafts
```

Two drafting engines, same output and same review gate:

**`--gemini`** uses Gemini with Google Search grounding — the machinery behind
the AI answers on Google. The model reads live pages instead of reciting
training data, and returns the pages it used, which are stored as the entry's
`sources`. It also reports a `confidence` and a list of `gaps` a reviewer must
confirm.

Needs `GEMINI_API_KEY` (free key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)) **in your
local environment** — this script runs on your machine, not on Vercel, so a key
added only in the Vercel dashboard will not be picked up. Either put it in
`.env`, or add it to the project and run `vercel env pull` (the script reads
`.env.local` too, which is where that writes). Note that a variable stored as
*Sensitive* in Vercel pulls down as a placeholder rather than the real value. The script
warns loudly when none of the grounding sources look municipal — grounding
searches the whole web, and a confident real-estate blog outranks a bylaw more
often than you would like.

**`--source <url>`** is the stricter path: it fetches the pages you name, the
prompt forbids using anything outside that text and returns
`{"insufficient": true}` rather than guessing, and every number the model emits
is checked back against the fetched text — anything not found verbatim is
dropped with a warning before the entry is written.

Grounding makes review fast and checkable. It does not replace review.

Entries can also just be hand-written. The script is a convenience, not the
gate; the review is.

**Only `verified` entries are served.** To look at a draft on the real site
before signing off, set `ZONES_PREVIEW_DRAFTS=1` — the draft then renders
labelled "Draft — not reviewed" in red, so a preview can't be mistaken for
reviewed content. Unset it for production.

There are ~693 distinct zone codes across the six municipalities (Squamish 122,
Whistler 212, DNV 186, SCRD 96, Sechelt 60, Gibsons 17), so this is not a list
to pre-fill. Misses are logged as `[zone-miss] <muni>:<ZONE>`, and

```bash
vercel logs --since 7d | node scripts/zones.mjs misses
```

ranks them, so drafting effort follows what visitors actually look up.

### Where the leads go

Right now: **the Vercel function logs only**, as `[lead] {json}`. That is fine
for testing and lossy for a real funnel.

For anywhere better, set `LEAD_WEBHOOK_URL` and each lead is POSTed there as
JSON — point it at Zapier, Make, HubSpot, or an internal endpoint, no code
change. Webhook failures are caught and never cost the visitor their answer.

```bash
vercel env add LEAD_WEBHOOK_URL production
```

The natural next step is writing them into the Supabase behind `land-dev-leads`
so parcel enquiries land in the same CRM as the scraped leads.

"Get an estimate for this parcel" closes the panel and hands the address, PID,
area, zoning, municipality **and stated intent** to the Instant Estimate chat as
an opening message.

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

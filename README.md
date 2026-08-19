# Landev Consulting — Website

Static homepage plus a serverless **Instant Estimate** chat, deployed on Vercel.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The whole homepage. Plain, editable HTML. |
| `api/chat.js` | Serverless chat endpoint. The system prompt at the top **is** the conversation design. |
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

## Local development

```bash
python3 -m http.server 8787
```

Serves the static page; `/api/chat` will 404. For the chat, use `vercel dev`.

## Deploy

```bash
vercel deploy --prod
```

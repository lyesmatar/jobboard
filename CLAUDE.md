# Job Scout

A small personal job board. A scheduled fetcher pulls postings from public job
sources, filters them to a configured set of fields and a home region, drops stale
and expired listings, and writes `data/jobs.json`. A single static `index.html`
renders that file with client-side filters.

> Local-only context (owner profile, tuning rationale, build strategy) lives in
> `../job-scout-PRIVATE-do-not-upload.md` — kept outside this folder so the whole
> folder is safe to upload to a public repo. Never move it back in.

## Configured for

Environmental / ecological-restoration / GIS / field & lab roles, plus
educational-assistant & science-teaching roles, in the Toronto / GTA area,
transit-accessible (no personal vehicle). Adjust via `sources.json` and the
`GTA` / `COMMUTE` tables in `index.html`.

## Hard constraints

- **Free only** — everything fits free tiers ($0/month). No paid scraper APIs.
- **No local toolchain** on the owner's machine (no node / git / npm). All builds
  and fetches run on GitHub's servers; the owner only uses a browser + the GitHub
  web UI. Don't write instructions that assume a local CLI.
- **Frontend is one dependency-free `index.html`** — no CDN, no framework, inline
  SVG, `data-action` event delegation. (Same philosophy as the sibling `gym-tracker`.)

## Freshness

- Hard cap: `max_days_old` in `sources.json` (7). The fetcher drops anything older,
  on every source; the frontend age filter is capped to match.
- Any posting past its `closingDate` (scraped, or parsed from posting text) is
  dropped by both the fetcher and the frontend.

## Architecture

- `index.html` — static site. Fetches `data/jobs.json`; falls back to
  `data/jobs.sample.json`, then to an inline `SAMPLE` constant (so opening the file
  directly still previews). All filtering is client-side, reflected in URL params
  (`?q=&region=&salary=&age=&fields=`).
- `sources.json` — source list + `search_terms` + `keywords` (field tagging) +
  the vehicle / relocation rules as prose notes.
- `scripts/fetch-jobs.mjs` — Node 20, zero deps. Adapters: `adzuna`, `atom`
  (Job Bank Canada), `rss` (WorkCabin), `greenhouse`, `lever`, `goodwork`, `ecoworks`
  (the last two are dedicated HTML scrapers — no feed exists — parsing the server-rendered
  listing pages; `max_pages` per source, default 3). Normalizes, tags a field by
  keyword, parses salary (annualizes hourly), flags `vehicleRequired` and `tenure`,
  keeps Canadian + within-cap + non-expired jobs, dedupes, writes `data/jobs.json`
  with a per-source `sources` health array.
- `.github/workflows/update-jobs.yml` — cron every 6h + manual dispatch; commits
  `data/jobs.json`; that push redeploys the host.

## Fields & the frontend

- Fields: `environmental` / `research` / `education` (+ `other`, off by default).
- Extra per-job signals surfaced as tags & filters: `closingDate` ("closes in N days"),
  `vehicleRequired` ("car needed", hidden by default), `tenure` (permanent / seasonal),
  transit commute estimate from Toronto (`COMMUTE` table: ttc / go / hard / remote).
- Local ("In your area") jobs render first; the secondary section "Permanent roles
  elsewhere in Canada" (permanent-only, shown when viewing the GTA) renders below it.
  Out-of-GTA seasonal roles are never surfaced.
- Theme: auto / light / dark toggle in the header (button, `data-action="theme"`),
  persisted in `localStorage.js_theme`. "auto" follows `prefers-color-scheme`. Palette
  is all CSS custom properties; an inline `<head>` script applies the saved theme
  pre-paint to avoid a flash.
- The filter pane is a sticky column with its own `overflow-y:auto` so it scrolls
  independently of the results list.
- "Source status" panel reads `data.sources` and shows each board as
  working / needs-setup / failing; boards deliberately switched off are collapsed
  into one muted "Not set up" line.

## Wired sources

- **Job Bank Canada** — Atom feed per search term, confirmed working
  (`jobsearch/feed/jobSearchRSSfeed?searchstring={term}&sort=D`). Feed returns only
  the ~13 newest per term; no closing dates in it.
- **WorkCabin** — RSS (`workcabin.ca/?feed=job_feed`), conservation & wildlife jobs,
  confirmed working. Coarse region location ("Central Canada" passes the CA filter).
- **GoodWork.ca** — dedicated HTML scraper (`type: goodwork`), confirmed working
  2026-09-08. No feed exists. Reads `/jobs`, `/jobs/2`, `/jobs/3`; real "Date posted",
  no closing date. Fragile — shows as `failing` if GoodWork restyles the list page.
- **ECOWorks (ECO Canada)** — dedicated HTML scraper (`type: ecoworks`), confirmed
  working 2026-09-08. Reads `/jobs?page=N`; relative "Nd ago" posted date. Same
  fragility caveat.
- **Adzuna CA** — needs `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` repo secrets (free key).
  Skipped gracefully if absent.
- **Greenhouse / Lever** — generic adapters; `boards` lists empty, add org slugs.
  Shown collapsed under "Not set up" until then.
- University Affairs / Academic Positions / CharityVillage — removed 2026-09-08;
  no confirmed public feed. Re-add with a verified feed URL if one is found.

## TODO / next

- Targeted per-platform adapters with real closing dates — see `PRIVATE_NOTES.md`
  for the build order (conservation authorities → OPS → ApplyToEducation → Workday → …).
- Job Bank feed is Quebec-heavy for generic terms; consider a province filter.
- The GoodWork / ECOWorks scrapers parse HTML positionally — re-check them if either
  board's "Source status" row flips to `failing`.

## Preferences

- Concise answers, lead with the result. Explain jargon — the owner is not a developer.
- Ask before destructive / hard-to-reverse actions.
- One clear recommendation, not a menu.

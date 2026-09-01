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
  (Job Bank Canada), `rss`, `greenhouse`, `lever`. Normalizes, tags a field by
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
- Secondary section "Permanent roles elsewhere in Canada" — permanent-only, shown
  when viewing the GTA. Out-of-GTA seasonal roles are never surfaced.
- "Source status" panel reads `data.sources` and shows each board as
  working / needs-setup / failing / off.

## Wired sources

- **Job Bank Canada** — Atom feed per search term, confirmed working
  (`jobsearch/feed/jobSearchRSSfeed?searchstring={term}&sort=D`). Feed returns only
  the ~13 newest per term; no closing dates in it.
- **Adzuna CA** — needs `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` repo secrets (free key).
  Skipped gracefully if absent.
- **Greenhouse / Lever** — generic adapters; `boards` lists empty, add org slugs.
- GoodWork.ca / ECOWorks / University Affairs / CharityVillage — `enabled:false`
  placeholders; GoodWork & ECOWorks have no public feed (would need scraping).

## TODO / next

- Targeted per-platform adapters with real closing dates — see `PRIVATE_NOTES.md`
  for the build order (conservation authorities → OPS → ApplyToEducation → Workday → …).
- Job Bank feed is Quebec-heavy for generic terms; consider a province filter.

## Preferences

- Concise answers, lead with the result. Explain jargon — the owner is not a developer.
- Ask before destructive / hard-to-reverse actions.
- One clear recommendation, not a menu.

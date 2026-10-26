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
- Exception (2026-10-14): a job marked `stillOpen` (future closing date, or a board that
  removes expired ads itself — WorkCabin) is kept up to `max_days_open` (60) days, and the
  frontend's default 7-day view shows it.

## Fit filtering (2026-10-14)

- Big general boards (Adzuna, Job Bank, City of Toronto, U of T) are categorized on the
  **job title only** — their descriptions mis-tagged buyers, data architects, IT techs.
  Niche env boards (RSS / WorkCabin) may also match on the description.
- `TITLE_BLOCK` + `TITLE_BLOCK_2` in `fetch-jobs.mjs` drop unfit titles (senior/manager/
  lead, engineers, software/data, climbing/DZ/ISA arborist, building-envelope/concrete labs,
  trades, fundraising, professors, early-childhood/RECE, …). Tune these when junk slips in.
- The 'Permanent roles elsewhere' section excludes education jobs.

## Architecture

- `index.html` — static site. Fetches `data/jobs.json`; falls back to
  `data/jobs.sample.json`, then to an inline `SAMPLE` constant (so opening the file
  directly still previews). All filtering is client-side, reflected in URL params
  (`?q=&region=&salary=&age=&fields=`).
- `sources.json` — source list + `search_terms` + `keywords` (field tagging) +
  the vehicle / relocation rules as prose notes.
- `scripts/fetch-jobs.mjs` — Node 20, zero deps. Adapters: `adzuna`, `atom`
  (Job Bank Canada), `rss`, `workcabin`, `successfactors` (City of Toronto, U of T), `gcjobs`, `greenhouse`, `lever`, `goodwork`, `ecoworks`
  (the last two are dedicated HTML scrapers — no feed exists — parsing the server-rendered
  listing pages; `max_pages` per source, default 3). Normalizes, tags a field by
  keyword, parses salary (annualizes hourly), flags `vehicleRequired` and `tenure`,
  keeps Canadian + within-cap + non-expired jobs, dedupes, writes `data/jobs.json`
  with a per-source `sources` health array.
- `.github/workflows/update-jobs.yml` — cron every 6h + manual dispatch; commits
  `data/jobs.json`; that push redeploys the host.

## Qualification check (2026-10-26)

- After filtering, `fetch-jobs.mjs` reads each kept job's full text (fetching the job page
  when the source only gave a title — Adzuna via `adzuna.ca/details/<id>`) and runs
  `assessFit()`: `fit` = yes / check / no / unknown + plain-English `fitWhy`.
- "no" = a hard requirement the owner lacks (sources.json `profile`): completed PhD, years of
  experience > `years_experience`+1, a licence (P.Eng/EIT, P.Geo, RPF, P.Ag, CMLTO/CSMLS, OCT,
  ISA, RECE, CPHI), current-student status, Canadian citizenship, equity-group-only, or
  "persons residing in <town>". Sentences containing "asset/preferred" are ignored.
  GC Jobs' "selection MAY be limited to equity groups" boilerplate is NOT a restriction.
- Frontend hides "no" by default ("Do I qualify?" checkbox; `?fit=all` shows them).

## Fields & the frontend

- Three tabs (2026-10-26): **Research** (category research, any location, GTA first) ·
  **In my area** (GTA + remote) · **Anywhere in Canada** (everything else). `?tab=`.

- Fields: `environmental` / `research` / `education` (+ `other`, off by default).
- Extra per-job signals surfaced as tags & filters: `closingDate` ("closes in N days"),
  `vehicleRequired` ("car needed", hidden by default), `tenure` (permanent / seasonal),
  transit commute estimate from Toronto (`COMMUTE` table: ttc / go / hard / remote).
- Since 2026-10-26 the owner is open to relocating: out-of-GTA seasonal / contract roles are
  shown (Anywhere in Canada tab), and "Hard without a car / would move" is on by default.
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
- **WorkCabin** — `type: workcabin`, WP Job Manager REST API
  (`/wp-json/wp/v2/job-listings`): real city + every live listing (the RSS only had a coarse
  region and 10 items). Falls back to the RSS `feed_url`.
- **City of Toronto** / **University of Toronto** — `type: successfactors`, keyword RSS
  (`<base>/services/rss/job/?locale=en_US&keywords=(term)`, 20 newest per term, per-source
  `terms`). Real closing dates ("Posting Period … to …" / "Closing Date:").
- **GC Jobs (federal)** — `type: gcjobs` (added 2026-10-26). Every federal job open to the
  public (Parks Canada, DFO, ECCC, NRCan, AAFC…), ~400, all pages each run. The search page
  is a shell; the results come from a second GET with `isSecondPartOfPage=1` on the same
  JSESSIONID. Real closing dates; no posted date (first-seen date carried over from the
  previous `data/jobs.json`). Dedupe keeps the `?poster=` query (it's the job id).
- **Not possible:** Ontario Public Service / gojobs (Radware CAPTCHA bot wall — don't try to
  bypass it; owner uses OPS email alerts) and TRCA (Dayforce, needs a browser session).
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

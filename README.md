# Job Scout

A small personal job board. It pulls postings from public job sources, filters them to a
configured set of fields and a home region, drops anything stale or past its closing date,
and shows what's left on one page.

**Configured for:** environmental / ecological-restoration / GIS / field & lab roles, plus
educational-assistant & science-teaching roles, in the **Toronto / GTA** area,
**transit-accessible** (jobs needing a personal car are hidden by default).

Runs entirely on free services. Cost: **$0/month** (a custom domain, if you ever want one,
is ~$15/year).

## Files

| File | What it is |
|---|---|
| `index.html` | The website. One file, no dependencies. Double-click to preview. |
| `data/jobs.json` | The job list. Rewritten automatically every 6 hours. |
| `data/jobs.sample.json` | Example data shown before the first real refresh. |
| `sources.json` | **The file you edit** — job sources, search terms, field keywords. |
| `scripts/fetch-jobs.mjs` | The fetcher. Runs on GitHub's servers, not your computer. |
| `.github/workflows/update-jobs.yml` | The schedule (every 6 hours). |

## Preview it now

Double-click `index.html`. You'll see example listings and every filter working. Nothing
is live yet — that needs the steps below.

---

## Put it online (one-time, ~15 min, all in a browser)

The site's files contain no personal information, so a free public GitHub repository is the
simplest host. Your name is not in the repo, and the web address is not listed anywhere.

### 1. GitHub account
Sign up at <https://github.com> (free). You can use any username. Verify your email.

### 2. New repository
- Top-right **+** → **New repository**.
- Name: `job-scout`. Visibility: **Public**.
- Don't add a README (this folder has one). **Create repository**.

### 3. Upload the folder
- On the repo page: **uploading an existing file**.
- Drag in **everything inside the `job-scout` folder**. (The private notes file is kept
  outside this folder on purpose, so the whole folder is safe to upload as-is.)
- Include the `.github` folder — if Explorer hides it, turn on
  *View → Show → Hidden items* first.
- **Commit changes**.

### 4. Turn on the website (GitHub Pages)
- Repo **Settings** → **Pages**.
- *Source*: **Deploy from a branch**. Branch **main**, folder **/ (root)**. **Save**.
- Wait ~1 min. Your address appears: `https://<username>.github.io/job-scout/`

### 5. Turn on the auto-refresh (GitHub Actions)
- **Settings** → **Actions** → **General** → *Workflow permissions* →
  **Read and write permissions** → **Save**.
- **Actions** tab → **I understand my workflows, enable them** if asked.
- Left list → **Update jobs** → **Run workflow** → **Run workflow**.
- A minute later it commits a fresh `data/jobs.json` and the site shows real jobs.
- It now runs itself every 6 hours.

### 6. Recommended: add the free Adzuna key
Without it the site still works (Job Bank Canada); with it, coverage roughly triples.
- Register at <https://developer.adzuna.com/signup> (free, instant).
- Copy your **App ID** and **App Key**.
- Repo **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
  - `ADZUNA_APP_ID` → your App ID
  - `ADZUNA_APP_KEY` → your App Key
- **Actions** → **Update jobs** → **Run workflow** again.

---

## Adding more job sources

Edit `sources.json` on GitHub (open the file → pencil icon → commit). The next run uses it.

| Type | How to add one |
|---|---|
| `rss` / `atom` | put a feed URL in `"url"`, set `"enabled": true` |
| `greenhouse` | add a company slug to `"boards"` (the name in `job-boards.greenhouse.io/<slug>`) |
| `lever` | add a slug to `"boards"` (the name in `jobs.lever.co/<slug>`) |

The **"Source status"** panel at the bottom of the site shows which sources are working,
need setup, or have stopped — so you can tell when one needs attention.

## Tuning

- `sources.json` → `search_terms` — the phrases searched on each source.
- `sources.json` → `keywords` — which field (`environmental` / `research` / `education`) a
  job is filed under, based on words in its title/description.
- `index.html` → the `GTA` list and `COMMUTE` table near the top of the `<script>` — which
  places count as "in your area" and their rough transit time from Toronto.

## Notes

- Every listing links to the **original posting** — apply there.
- The fetcher only keeps Canadian jobs posted in the last **7 days**, and drops any job
  past its stated closing date. Stale postings can't be detected reliably, so the window
  is kept short on purpose.
- If a run keeps **0 jobs**, check the Actions log — usually a feed URL changed or a key
  is wrong.

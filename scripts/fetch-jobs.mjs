// Job Scout — job feed aggregator.
// Runs on GitHub Actions (Node 20+, no dependencies). Reads sources.json,
// fetches every enabled source, normalizes + dedupes, writes data/jobs.json.
//
// Run locally (if you have Node): `node scripts/fetch-jobs.mjs`
// Adzuna needs env vars ADZUNA_APP_ID and ADZUNA_APP_KEY (optional; skipped if absent).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await readFile(join(ROOT, "sources.json"), "utf8"));

const UA = "JobScout/1.0 (+personal job aggregator)";
// Some HTML job boards 403 a bot User-Agent. The scraper adapters send this instead.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const BROWSER_HEADERS = { "User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml" };
const now = Date.now();
const MAX_AGE_MS = (cfg.max_days_old || 7) * 86400000;

// Province names + the "City (PROV)" / "City, PROV" abbreviation forms Job Bank and
// Adzuna both use. Tested against a real Job Bank feed: locations look like "Toronto (ON)".
const CANADA_PROV = ["on", "qc", "bc", "ab", "mb", "sk", "ns", "nb", "nl", "pe", "yt", "nt", "nu"];
const CANADA_RE = new RegExp(
  "\\b(canada|canadian|ontario|quebec|qu[eé]bec|british columbia|alberta|manitoba|"
  + "saskatchewan|nova scotia|new brunswick|newfoundland|labrador|prince edward|"
  + "yukon|northwest territories|nunavut|remote|work from home|t[eé]l[eé]travail)\\b"
  + "|[(,]\\s*(" + CANADA_PROV.join("|") + ")(?=[)\\s,.]|$)", "i");

/* ----------------------------- helpers ----------------------------- */

async function getJSON(url, opts) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

// "3d ago" / "2w ago" / "5h ago" -> ISO timestamp.
function relativeAgeToISO(text) {
  const m = String(text || "").match(/(\d+)\s*([hdwmy])(?:ay|ays|our|ours|eek|eeks|onth|onths|ear|ears)?\s*ago/i);
  if (!m) return null;
  const unit = { h: 3.6e6, d: 8.64e7, w: 6.048e8, m: 2.63e9, y: 3.156e10 }[m[2].toLowerCase()];
  const d = new Date(now - Number(m[1]) * unit);
  return isNaN(d) ? null : d.toISOString();
}

const stripTags = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;|&apos;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, " ").trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
function blocks(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}[^>]*>[\\s\\S]*?</${name}>`, "gi"))].map(m => m[0]);
}

// Match a keyword at a word boundary (prefix ok, so "ecolog" catches "ecology"/"ecologist"),
// NOT as a bare substring — otherwise "GIS" matches "reGIStered" / "technoloGISt" / "loGIStics"
// and the whole feed gets mis-tagged.
const kwRe = w => new RegExp("\\b" + w.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
function categorize(text) {
  const k = cfg.keywords;
  const hit = list => (list || []).some(w => kwRe(w).test(text));
  // environmental is the primary field — check it first
  if (hit(k.environmental)) return "environmental";
  if (hit(k.education)) return "education";
  if (hit(k.research)) return "research";
  return "other";
}

// Would this posting be a problem for someone who drives (Ontario G2) but has no vehicle
// of their own? Flags: requires your OWN vehicle, OR requires a FULL Class G (not G2).
// NOT a blocker: a plain "valid driver's licence", "G2 acceptable", crew transport, or a
// company/fleet vehicle that's provided.
function needsOwnVehicle(text) {
  const t = (text || "").toLowerCase();
  if (/(transportation|transport|vehicle) (is |will be )?provided|crew transport|company vehicle|fleet vehicle|pool vehicle|g2 licence acceptable|g2 license acceptable/.test(t)) return false;
  const ownVehicle = /own (vehicle|car|transportation)|personal vehicle|reliable vehicle|access to a( reliable)? vehicle|use of a (personal |reliable )?vehicle|must (have|provide) .{0,20}vehicle|provide your own transportation/.test(t);
  const fullGonly = /\bfull (class )?g (driver'?s )?licen[cs]e\b|\bclass g (driver'?s )?licen[cs]e\b(?!.{0,4}2)/.test(t) && !/\bg2\b/.test(t);
  return ownVehicle || fullGonly;
}

// Rough permanent-vs-temporary read (matters for the relocation rule).
function tenure(text, employmentType) {
  const t = ((employmentType || "") + " " + (text || "")).toLowerCase();
  if (/\b(seasonal|temporary|contract|casual|term|fixed[- ]term|co-?op|internship|summer position|8[- ]month|contract position)\b/.test(t)) return "temporary";
  if (/\b(permanent|full[- ]time permanent|regular full[- ]time|continuing|indeterminate)\b/.test(t)) return "permanent";
  return "unknown";
}
function workMode(text) {
  const t = text.toLowerCase();
  if (/\b(fully remote|100% remote|remote position|work from home|télétravail)\b/.test(t)) return "remote";
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(on-?site|in office|in-person)\b/.test(t)) return "onsite";
  if (/\bremote\b/.test(t)) return "remote";
  return "unknown";
}
function parseSalary(text) {
  if (!text) return {};
  const nums = [...String(text).matchAll(/\$\s?([\d]{2,3}(?:[ ,]\d{3})+|\d{1,3}(?:\.\d+)?)/g)]
    .map(m => parseFloat(m[1].replace(/[ ,]/g, "")));
  if (!nums.length) return {};
  const hourly = /per hour|\/\s?h(ou)?r|hourly|\/hr/i.test(text);
  let vals = nums.filter(n => n > 0);
  if (hourly) vals = vals.map(n => Math.round(n * 2080));
  vals = vals.filter(n => n >= 20000 && n <= 500000);
  if (!vals.length) return {};
  return { salaryMin: Math.min(...vals), salaryMax: Math.max(...vals) };
}
function looksCanadian(loc, extra = "") {
  return CANADA_RE.test(loc + " " + extra);
}
function ageOK(iso) {
  const t = new Date(iso).getTime();
  return !isNaN(t) && (now - t) <= MAX_AGE_MS && t <= now + 86400000;
}

// SHOUTING TITLES (City of Toronto) -> Title Case, so cards stay readable.
function fixCaps(t) {
  if (!t || /[a-z]/.test(t)) return t;
  return t.toLowerCase().replace(/\b([a-zà-ÿ])/g, c => c.toUpperCase())
    .replace(/\b(Gis|Pf&r|Ecs|Tw|It|Hr|Ii|Iii|Iv)\b/g, w => w.toUpperCase());
}

function normalize(raw) {
  // fullText = the whole posting (used for vehicle / tenure / closing-date detection);
  // summary = what the card shows. Most adapters only have one, so they're the same.
  const full = raw.fullText || raw.summary || "";
  const blob = `${raw.title} ${raw.org} ${full} ${raw.location || ""}`;
  // Categorize on the TITLE only for big general boards (Adzuna, Job Bank, City, U of T):
  // their long descriptions mention "environmental"/"sustainability"/"forestry" in
  // boilerplate, which tagged Buyers, Data Architects and IT techs as environmental.
  // Niche environmental boards (match_description) may also match on the description.
  // Never on the employer name ("helper, mason" @ "Concrete Restoration Canada").
  const catBlob = raw.matchDescription ? `${raw.title} ${full}` : raw.title;
  const sal = (raw.salaryMin || raw.salaryMax) ? raw
    : { ...raw, ...parseSalary(raw.salaryText || full) };
  const closingDate = raw.closingDate || parseClosing(full) || null;
  return {
    id: raw.id,
    title: fixCaps(stripTags(raw.title)).slice(0, 200),
    org: stripTags(raw.org || "—").slice(0, 140),
    location: stripTags(raw.location || "").slice(0, 120),
    remote: raw.remote || workMode(blob),
    salaryMin: sal.salaryMin || null,
    salaryMax: sal.salaryMax || null,
    salaryText: raw.salaryText || null,
    category: raw.category || categorize(catBlob),
    url: raw.url,
    source: raw.source,
    posted: raw.posted,
    closingDate,
    // stillOpen = we know the posting is live past the 7-day window: either it states a
    // future closing date, or the board itself removes expired listings (WorkCabin).
    stillOpen: !!(raw.stillOpen || (closingDate && closingDate >= new Date().toISOString().slice(0, 10))),
    vehicleRequired: raw.vehicleRequired ?? needsOwnVehicle(blob),
    tenure: raw.tenure || tenure(blob, raw.employmentType),
    summary: stripTags(raw.summary || "").slice(0, 600) || null,
    _text: stripTags(full),   // full posting text for the qualification check; not written out
  };
}

// Pull a "closing date" / "apply by" date out of free text, if present.
// Works on stripped text so "<strong>Closing Date:</strong> 10/15/2026" (U of T) matches.
// Labels are tried in order, so an explicit "Closing Date:" beats a stray "deadline" in the body.
// City of Toronto uses "Posting Period: 08-Oct-2026 to 23-Oct-2026" — the second date is the close.
const CLOSING_LABELS = ["closing date", "posting end date", "posting close date", "posting period:[^.]{0,30}? to",
  "closes on", "apply by", "application deadline", "posting expires on", "expiry date", "deadline"];
const DATE_RE = "([A-Za-z]+\\.? \\d{1,2},? \\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{1,2}-[A-Za-z]{3}-\\d{4})";
function parseClosing(text) {
  if (!text) return null;
  const t = stripTags(text);
  for (const label of CLOSING_LABELS) {
    const m = t.match(new RegExp("(?:" + label + ")[:\\s]*" + DATE_RE, "i"));
    if (!m) continue;
    const d = new Date(m[1].replace(".", "").replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/, "$2 $1, $3"));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  return null;
}

/* ----------------------------- adapters ----------------------------- */

async function fromAdzuna(src) {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) { console.log("  adzuna: no ADZUNA_APP_ID/APP_KEY — skipped"); return []; }
  const out = [];
  for (const term of cfg.search_terms) {
    const u = `https://api.adzuna.com/v1/api/jobs/${src.country || "ca"}/search/1`
      + `?app_id=${id}&app_key=${key}&results_per_page=50&max_days_old=${cfg.max_days_old || 7}`
      + `&what=${encodeURIComponent(term)}&content-type=application/json`;
    try {
      const data = await getJSON(u);
      for (const j of data.results || []) {
        out.push(normalize({
          id: "adzuna-" + j.id,
          title: j.title,
          org: j.company?.display_name,
          location: j.location?.display_name,
          salaryMin: j.salary_is_predicted === "1" ? null : Math.round(j.salary_min || 0) || null,
          salaryMax: j.salary_is_predicted === "1" ? null : Math.round(j.salary_max || 0) || null,
          remote: j.contract_time === "part_time" ? "unknown" : undefined,
          employmentType: j.contract_type,
          url: j.redirect_url,
          source: "Adzuna",
          posted: j.created,
          summary: j.description,
        }));
      }
    } catch (e) { console.log(`  adzuna "${term}": ${e.message}`); }
    await sleep(400);
  }
  return out;
}

function parseAtom(xml, sourceName) {
  return blocks(xml, "entry").map(e => {
    const link = (e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i)
      || e.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || tag(e, "link");
    // Job Bank packs "Job number / Location / Employer / Salary" into <summary>, separated by <br>.
    const summary = stripTags(tag(e, "summary") || tag(e, "content"))
      .replace(/&amp;/g, "&");
    const field = label =>
      (summary.match(new RegExp(label + ":\\s*(.+?)(?:\\s+(?:Job number|Location|Employer|Salary|Closing date):|$)", "i")) || [])[1]
        ?.trim() || "";
    const loc = field("Location");
    const emp = field("Employer");
    const salText = field("Salary");
    return normalize({
      id: sourceName + "-" + (tag(e, "id").split(/[?#]/).pop() || link),
      title: tag(e, "title"),
      org: emp || sourceName,
      location: /not available/i.test(loc) ? "" : loc,
      salaryText: salText || null,
      url: link,
      source: sourceName,
      posted: tag(e, "updated") || tag(e, "published") || new Date().toISOString(),
      // Job Bank's <summary> is only the structured fields we've already pulled out
      // (job #, location, employer, salary). Keeping it would pollute categorization
      // with the employer name, so drop it — the title is the real signal here.
      summary: null,
    });
  });
}

function parseRSS(xml, sourceName) {
  return blocks(xml, "item").map(it => {
    const desc = tag(it, "description") || tag(it, "content:encoded");
    // WP Job Manager feeds (WorkCabin etc.) carry structured job_listing:* fields —
    // the plain <location> tag is empty on those, so fall back to job_listing:location.
    const jmOrg = tag(it, "job_listing:company");
    const jmLoc = tag(it, "job_listing:location");
    const jmSal = tag(it, "job_listing:salary");
    return normalize({
      id: sourceName + "-" + (tag(it, "guid") || tag(it, "link")),
      title: tag(it, "title"),
      org: jmOrg || sourceName,
      location: jmLoc || tag(it, "location") || "",
      salaryText: jmSal || null,
      matchDescription: true,   // RSS sources here are niche environmental boards
      url: tag(it, "link"),
      source: sourceName,
      posted: tag(it, "pubDate") ? new Date(tag(it, "pubDate")).toISOString() : new Date().toISOString(),
      summary: desc,
    });
  });
}

async function fromFeed(src, kind) {
  const name = src.source_name || src.id;
  const urls = src.per_term
    ? cfg.search_terms.map(t => src.url_template.replace("{term}", encodeURIComponent(t)))
    : [src.url].filter(Boolean);
  if (!urls.length) { console.log(`  ${name}: no url configured — skipped`); return []; }
  const out = [];
  for (const u of urls) {
    try {
      const xml = await getText(u);
      out.push(...(kind === "atom" ? parseAtom(xml, name) : parseRSS(xml, name)));
    } catch (e) { console.log(`  ${name}: ${e.message}`); }
    await sleep(400);
  }
  return out;
}

async function fromGreenhouse(src) {
  const out = [];
  for (const slug of src.boards || []) {
    try {
      const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      for (const j of data.jobs || []) {
        out.push(normalize({
          id: "gh-" + slug + "-" + j.id,
          title: j.title,
          org: slug,
          location: j.location?.name,
          url: j.absolute_url,
          source: "Greenhouse",
          posted: j.updated_at,
          summary: j.content,
        }));
      }
    } catch (e) { console.log(`  greenhouse ${slug}: ${e.message}`); }
    await sleep(300);
  }
  return out;
}

async function fromLever(src) {
  const out = [];
  for (const slug of src.boards || []) {
    try {
      const data = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      for (const j of data || []) {
        out.push(normalize({
          id: "lever-" + j.id,
          title: j.text,
          org: slug,
          location: j.categories?.location,
          remote: /remote/i.test(j.workplaceType || "") ? "remote" : undefined,
          url: j.hostedUrl,
          source: "Lever",
          posted: new Date(j.createdAt).toISOString(),
          summary: j.descriptionPlain,
        }));
      }
    } catch (e) { console.log(`  lever ${slug}: ${e.message}`); }
    await sleep(300);
  }
  return out;
}

// GoodWork.ca — Canada's largest environmental / conservation / sustainability board.
// No feed; server-rendered HTML. Each listing row:
//   <div class="listingthumb row"> … <a href="/jobs/<slug>-<id>"><span>TITLE</span></a>,
//   <type>, <org>, <city PROV / mode> … <span title="… Date posted: Mon D, YYYY.">
// Pages are /jobs, /jobs/2, /jobs/3 … Sorted newest-first, so a couple of pages
// covers everything inside the 7-day window. No per-job closing date in the list.
async function fromGoodwork(src) {
  const base = (src.url || "https://www.goodwork.ca/jobs").replace(/\/+$/, "");
  const pages = Math.max(1, src.max_pages || 3);
  const TYPE_RE = /^(full[- ]?time|part[- ]?time|contract|casual|seasonal|temporary|permanent|volunteer|internship|intern|co-?op|term|freelance|flexible|summer)/i;
  const LOC_RE = /\b(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b|remote|hybrid|virtual|anywhere in canada|\bcanada\b|\bGTA\b/i;
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const u = p === 1 ? base : `${base}/${p}`;
    try {
      const html = await getText(u, BROWSER_HEADERS);
      const chunks = html.split(/<div [^>]*listingthumb[^>]*>/i).slice(1);
      for (const c of chunks) {
        const idM = c.match(/\/jobs\/([a-z0-9-]+-(\d{3,}))/i);
        if (!idM) continue;
        let title = null, trailing = "";
        const aRe = /<a\s[^>]*href="\/jobs\/[^"]*"[^>]*>([\s\S]*?)<\/a>([^<]*)/gi;
        let am;
        while ((am = aRe.exec(c))) {
          const t = stripTags(am[1]);
          if (t) { title = t; trailing = stripTags(am[2]); break; }
        }
        if (!title) continue;
        const dM = c.match(/Date posted:\s*([A-Za-z.]{3,10}\s+\d{1,2},?\s+\d{4})/i);
        const posted = dM ? new Date(dM[1]) : null;
        // trailing looks like ", full-time, Metcalf Foundation, Toronto ON / Hybrid"
        let parts = trailing.replace(/^[,\s]+/, "").split(/\s*,\s*/).filter(Boolean);
        let employmentType = null;
        if (parts.length && TYPE_RE.test(parts[0])) employmentType = parts.shift();
        let location = "";
        for (let k = parts.length - 1; k >= 0; k--) {
          if (LOC_RE.test(parts[k])) { location = parts.slice(k).join(", "); parts = parts.slice(0, k); break; }
        }
        const org = parts.join(", ") || "GoodWork.ca";
        out.push(normalize({
          id: "goodwork-" + idM[2],
          title,
          org,
          location,
          url: "https://www.goodwork.ca" + idM[0],
          source: "GoodWork.ca",
          posted: posted && !isNaN(posted) ? posted.toISOString() : new Date().toISOString(),
          employmentType,
          summary: [employmentType, org, location].filter(Boolean).join(" · ") || null,
        }));
      }
    } catch (e) { console.log(`  goodwork p${p}: ${e.message}`); }
    await sleep(500);
  }
  return out;
}

// ECOWorks (ECO Canada) — environmental job board, no feed, server-rendered HTML.
// Each listing: <div class="… job-listings-item …"> with
//   <a href="/jobs/<id>-<slug>">TITLE</a>, <span class="jb-tag-underline-on-hover">EMPLOYER</span>,
//   a "• Type • Location • $Salary" run, and <span class="job-posted-date">Nd ago</span>.
// Pages are /jobs?page=N. Newest-first.
async function fromEcoworks(src) {
  const base = src.url || "https://ecoworks.eco.ca/jobs";
  const pages = Math.max(1, src.max_pages || 3);
  const TYPE_RE = /^(full[- ]?time|part[- ]?time|contract|casual|season|tempor|permanent|intern|co-?op|freelance|volunteer)/i;
  const LOC_RE = /(canada|ontario|alberta|qu[eé]bec|british columbia|manitoba|nova scotia|saskatchewan|yukon|newfoundland|new brunswick|prince edward|remote|hybrid)/i;
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const u = p === 1 ? base : base + (base.includes("?") ? "&" : "?") + "page=" + p;
    try {
      const html = await getText(u, BROWSER_HEADERS);
      const chunks = html.split(/job-listings-item/).slice(1);
      for (const c0 of chunks) {
        const c = c0.slice(0, 8000);
        const idM = c.match(/\/jobs\/(\d{3,})-[a-z0-9-]+/i);
        if (!idM) continue;
        const aM = c.match(/<a\s[^>]*href="[^"]*\/jobs\/\d{3,}-[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
        const title = aM ? stripTags(aM[1]) : null;
        if (!title) continue;
        const empM = c.match(/jb-tag-underline-on-hover[\s\S]{0,40}?>([\s\S]*?)<\/a>/i);
        const org = (empM && stripTags(empM[1])) || "ECOWorks";
        const posted = relativeAgeToISO(c) || new Date().toISOString();
        let rest = stripTags(c);
        rest = rest.replace(title, "");
        if (org && rest.includes(org)) rest = rest.split(org).slice(1).join(" ");
        const segs = rest.split(/\s*[•·|]\s*/).map(s => s.trim()).filter(Boolean);
        const salaryText = segs.find(s => /\$\s?\d/.test(s)) || null;
        const employmentType = segs.find(s => TYPE_RE.test(s)) || null;
        const location = segs.find(s => s !== salaryText && s !== employmentType && LOC_RE.test(s)) || "";
        out.push(normalize({
          id: "ecoworks-" + idM[1],
          title,
          org,
          location,
          salaryText,
          url: "https://ecoworks.eco.ca" + idM[0],
          source: src.source_name || "ECOWorks",
          posted,
          employmentType,
          summary: [employmentType, location].filter(Boolean).join(" · ") || null,
        }));
      }
    } catch (e) { console.log(`  ecoworks p${p}: ${e.message}`); }
    await sleep(500);
  }
  return out;
}

// WorkCabin — WP Job Manager's REST API (/wp-json/wp/v2/job-listings). Better than the
// RSS feed: real city ("Trenton, ON") instead of a region ("Central Canada"), and it
// lists EVERY live posting, not just the 10 newest. WorkCabin removes filled/expired
// listings itself, so these are marked stillOpen and skip the 7-day cap.
// Falls back to the RSS feed (src.feed_url) if the API ever goes away.
async function fromWorkcabin(src) {
  const name = src.source_name || src.id;
  const api = src.url || "https://www.workcabin.ca/wp-json/wp/v2/job-listings";
  try {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`${api}?per_page=100&page=${page}&_fields=id,date_gmt,link,title,content,meta`,
        { headers: BROWSER_HEADERS });
      if (r.status === 400 && page > 1) break;   // WP returns 400 past the last page
      if (!r.ok) throw new Error(`${r.status} ${api}`);
      const rows = await r.json();
      for (const j of rows) {
        const m = j.meta || {};
        if (Number(m._filled) === 1) continue;
        const flex = String(m._job_flexibility || "").toLowerCase();
        out.push(normalize({
          id: "workcabin-" + j.id,
          title: stripTags(j.title?.rendered),
          org: m._company_name || name,
          location: m._job_location || "",
          remote: /remote/.test(flex) ? "remote" : /hybrid/.test(flex) ? "hybrid" : /on-?site/.test(flex) ? "onsite" : undefined,
          url: j.link,
          source: name,
          posted: new Date((j.date_gmt || "") + "Z").toISOString(),
          summary: j.content?.rendered,
          matchDescription: true,
          stillOpen: true,
        }));
      }
      if (rows.length < 100) break;
      await sleep(400);
    }
    return out;
  } catch (e) {
    console.log(`  ${name} API: ${e.message} — falling back to RSS`);
    if (!src.feed_url) throw e;
    return parseRSS(await getText(src.feed_url), name);
  }
}

// SAP SuccessFactors career sites (City of Toronto, University of Toronto, …) expose a
// keyword RSS: <base>/services/rss/job/?locale=en_US&keywords=(term). Title carries the
// location: "PLANT TECHNICIAN WASTEWATER (Toronto, ON, CA, M5A 4C6)". Descriptions carry
// "Closing Date:" (U of T) or "Posting End Date:" (City) — parsed into closingDate.
// Keyword search is full-text, so results are categorized on the TITLE only.
async function fromSuccessFactors(src) {
  const name = src.source_name || src.id;
  const base = src.url.replace(/\/+$/, "");
  const out = [];
  let fails = 0;
  const terms = src.terms || cfg.search_terms;
  for (const term of terms) {
    const u = `${base}/services/rss/job/?locale=en_US&keywords=(${encodeURIComponent(term)})`;
    try {
      const xml = await getText(u, { "User-Agent": BROWSER_UA, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8" });
      for (const it of blocks(xml, "item")) {
        const rawTitle = stripTags(tag(it, "title"));
        const lm = rawTitle.match(/^(.*)\(([^()]*,\s*[A-Z]{2},\s*CA[^()]*)\)\s*$/);
        const title = lm ? lm[1].trim() : rawTitle;
        if (/^no jobs currently available/i.test(title)) continue;   // City's empty-search placeholder
        const location = lm ? lm[2].split(",").slice(0, 2).map(s => s.trim()).join(", ") : (src.default_location || "");
        const link = stripTags(tag(it, "link")).split("?")[0];
        const desc = tag(it, "description");
        const text = stripTags(desc);
        // Card summary: skip boilerplate preamble, start at the job content when we can find it.
        const startM = text.match(/(Major Responsibilities|Responsibilities|POSITION DESCRIPTION|Job Summary|About the (?:role|opportunity)|Your opportunity)/i);
        const typeM = text.match(/Job (?:Type|Category)\s*:\s*([^:]{3,60}?)\s+(?:Hourly Rate|Salary|Job Type|Number of|Faculty|Start Date|Req ID|Division|Hiring)/i);
        const salM = text.match(/(?:Hourly Rate|Salary(?: Range)?|Wage)\s*:\s*(\$\s?[\d,.]+(?:\s*(?:-|–|to)\s*\$?\s?[\d,.]+)?)/i);
        out.push(normalize({
          id: src.id + "-" + (link.match(/\/(\d{6,})\/?$/) || [, link])[1],
          title,
          org: src.org || name,
          location,
          salaryText: salM ? salM[1] + (/Hourly Rate/i.test(salM[0]) ? " / hour" : "") : null,
          employmentType: typeM ? typeM[1] : null,
          url: link,
          source: name,
          posted: tag(it, "pubDate") ? new Date(tag(it, "pubDate")).toISOString() : new Date().toISOString(),
          summary: (typeM ? typeM[1] + " · " : "") + (startM ? text.slice(startM.index) : text),
          fullText: text,
        }));
      }
    } catch (e) { fails++; console.log(`  ${name} "${term}": ${e.message}`); }
    await sleep(400);
  }
  if (fails === terms.length) throw new Error(`all ${fails} requests failed (site changed?)`);
  return out;
}

// GC Jobs (federal public service: Parks Canada, DFO, ECCC, NRCan, …). No feed. The search
// page is a shell ("The page is being updated…") that fills itself with a second GET of the
// same URL + isSecondPartOfPage=1, on the same JSESSIONID. That returns every job open to the
// public, 20 per page (?requestedPage=N, also needs isSecondPartOfPage=1). Each <li class="searchResult">:
//   <a href="/psrs-srfp/applicant/page1800?poster=ID">TITLE</a>
//   Closing date: YYYY-MM-DD <br/> DEPARTMENT <br/> City (Province), City (Province) | language <br/> salary
// No posted date in the list — first-seen date is carried over from the previous jobs.json.
async function fromGCJobs(src) {
  const name = src.source_name || src.id;
  const B = "https://emploisfp-psjobs.cfp-psc.gc.ca/psrs-srfp/applicant/page2440";
  const jar = {};
  const get = async u => {
    const r = await fetch(u, { headers: { ...BROWSER_HEADERS, Cookie: Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ") } });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(";")[0]; const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    if (!r.ok) throw new Error(`${r.status} ${u}`);
    return r.text();
  };
  await get(B + "?fromMenu=true&toggleLanguage=en");
  let html = await get(B + "?fromMenu=true&toggleLanguage=en&isSecondPartOfPage=1&isInitialNetworkCheck=1");
  const total = +(html.match(/Jobs open to the public \((\d+)\)/) || [])[1] || 0;
  if (!total) throw new Error("no 'Jobs open to the public' count (site changed?)");
  const out = [];
  for (let p = 1; p <= Math.min(Math.ceil(total / 20), src.max_pages || 40); p++) {
    if (p > 1) { await sleep(400); html = await get(B + `?requestedPage=${p}&fromPage=1&tab=1&log=false&isSecondPartOfPage=1`); }
    for (const li0 of html.split(/<li class="searchResult">/).slice(1)) {
      const li = li0.slice(0, li0.indexOf("</li>"));
      const aM = li.match(/page1800\?poster=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      if (!aM) continue;
      const cells = [...li.matchAll(/<div class="tableCell">([\s\S]*?)<\/div>/g)]
        .map(m => m[1].split(/<br\s*\/?>/).map(stripTags).filter(Boolean));
      const [left = [], right = []] = cells;
      const closingDate = ((left[0] || "").match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null;
      const id = "gcjobs-" + aM[1];
      out.push(normalize({
        id,
        title: stripTags(aM[2]),
        org: left[1] || "Government of Canada",
        location: left.slice(2).join(", "),
        salaryText: right.find(s => /\$/.test(s)) || null,
        url: `https://emploisfp-psjobs.cfp-psc.gc.ca/psrs-srfp/applicant/page1800?poster=${aM[1]}&toggleLanguage=en`,
        source: name,
        posted: PREV_POSTED.get(id) || new Date().toISOString(),
        closingDate,
        summary: [left[1], right.join(" · ")].filter(Boolean).join(" · "),
      }));
    }
  }
  console.log(`  gcjobs: ${out.length} of ${total} public postings`);
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// First-seen dates from the previous run, for boards that don't publish a posted date (GC Jobs).
const PREV_POSTED = new Map();
try {
  const prev = JSON.parse(await readFile(join(ROOT, "data", "jobs.json"), "utf8"));
  for (const j of prev.jobs || []) PREV_POSTED.set(j.id, j.posted);
} catch { /* first run */ }

/* ----------------------------- run ----------------------------- */

const wantedCats = new Set(["environmental", "research", "education"]);
let all = [];
const status = [];  // per-source health, written into jobs.json for the site's status panel

for (const src of cfg.sources) {
  const name = src.source_name || src.id;
  if (!src.enabled) {
    status.push({ id: src.id, name, state: "off", raw: 0,
      message: src.note ? src.note.split(". ")[0] + "." : "Disabled in sources.json." });
    continue;
  }
  console.log(`Source: ${src.id} (${src.type})`);
  const before = all.length;
  let err = null;
  try {
    if (src.type === "adzuna") all.push(...await fromAdzuna(src));
    else if (src.type === "atom") all.push(...await fromFeed(src, "atom"));
    else if (src.type === "rss") all.push(...await fromFeed(src, "rss"));
    else if (src.type === "greenhouse") all.push(...await fromGreenhouse(src));
    else if (src.type === "lever") all.push(...await fromLever(src));
    else if (src.type === "goodwork") all.push(...await fromGoodwork(src));
    else if (src.type === "ecoworks") all.push(...await fromEcoworks(src));
    else if (src.type === "workcabin") all.push(...await fromWorkcabin(src));
    else if (src.type === "successfactors") all.push(...await fromSuccessFactors(src));
    else if (src.type === "gcjobs") all.push(...await fromGCJobs(src));
    else { err = `unknown source type "${src.type}"`; console.log("  " + err); }
  } catch (e) { err = e.message; console.log(`  ${src.id} failed: ${e.message}`); }

  const got = all.length - before;
  // "needs-setup" = a source that would clearly add coverage if you spent 2 minutes on it.
  const needsSetup = src.type === "adzuna" && !(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
  // "off" = optional and simply not configured yet (no feed URL / no board slugs).
  const notConfigured = ((src.type === "rss" || src.type === "atom") && !src.url && !src.url_template)
    || ((src.type === "greenhouse" || src.type === "lever") && !(src.boards || []).length);
  status.push({
    id: src.id, name, raw: got,
    state: err ? "error" : needsSetup ? "needs-setup" : notConfigured ? "off" : got > 0 ? "ok" : "empty",
    message: err ? `Last run failed: ${err}`
      : needsSetup ? "Add a free Adzuna API key (ADZUNA_APP_ID / ADZUNA_APP_KEY repo secrets) to roughly triple coverage."
      : notConfigured ? "Optional — not set up yet. Add feed URLs / board names in sources.json to enable."
      : got > 0 ? `Fetched ${got} raw postings this run.`
      : "Ran OK but returned nothing this run (may just mean no new matching jobs).",
  });
}

console.log(`\nCollected ${all.length} raw postings`);

// Job titles that are clearly NOT in scope, even if "environmental" / "sustainability"
// shows up somewhere in the description (ESG counsel, an accountant at a green firm, etc.)
// Also excludes senior/leadership titles (owner is early-career, "Senior"/"Manager"/"Director"/
// "VP" roles at any employer are out of reach) and IT/customer-service roles that get mis-tagged
// "environmental" because they're posted by an environmental/forestry-sector employer
// (e.g. "Customer Service Administrator" at an eco-instruments company, "Network & Security
// Specialist" at a forestry company) rather than because the role itself is environmental.
const TITLE_BLOCK = /\b(counsel|lawyer|paralegal|attorney|accountant|accounting|bookkeeper|payroll|auditor|actuary|underwriter|sales representative|account executive|business development|marketing manager|recruiter|talent acquisition|realtor|real estate|insurance broker|financial advisor|loan officer|barista|cashier|server|dishwasher|line cook|warehouse associate|forklift|truck driver|delivery driver|heavy duty (mechanic|technician)|heavy equipment|\bmechanic\b|millwright|welder|electrician|plumber|hvac|roofer|carpenter|mason|nurse|physician|pharmacist|dental|veterinari|paramedic|personal support worker|\bpsw\b|vice president|\bvp\b|\bdirector\b|head of|\bchief\b|\bsenior\b|\bmanager\b|customer service|network (&|and)? ?security|network specialist|network administrator|network engineer|systems administrator|\bit support\b|help desk)\b/i;

// Second block list (added 2026-10-14): titles that matched a keyword but aren't a fit —
// engineers & software/data roles, construction-materials labs, utility line-clearance
// climbing / DZ-licence arborist work, ISA-certified roles, trades, leadership & fundraising,
// faculty posts that need a PhD, food-safety / EHS, retail sales, film "vegetation artists".
const TITLE_BLOCK_2 = new RegExp("\\b(" + [
  "engineer\\w*", "ing[ée]nieur\\w*", "architect", "developer", "software", "programmer", "data engineer",
  "embedded", "computer science", "buyer", "procurement", "superintendent", "supervisor", "foreperson",
  "foreman", "climb\\w*", "tree trimmer", "dz", "az driver", "isa certified", "certified utility arborist",
  "cua", "sales\\w*", "vendeu\\w*", "artist", "disaster", "damage", "mou?ld", "asbestos", "building envelope",
  "concrete", "asphalt", "heavy duty", "het", "gutter", "window", "president", "executive director",
  "fundrais\\w*", "donor", "philanthropy", "professor", "fsqa", "food safety", "ehs", "hse",
  "health (and|&) safety", "stationary", "energy specialist", "mining", "canvass\\w*",
  "early childhood", "ece", "rece", "child care", "childcare", "daycare", "administrative",
].join("|") + ")\\b|(?<!crew )\\blead\\b", "i");
// Upper-case "IT" only (case-sensitive) so "IT Field Technician" goes but nothing else does.
const isITJob = t => /\bIT\b/.test(t);

// "restoration" also means building/damage/disaster restoration — exclude those by employer.
const BUILDING_RESTO = /building|masonry|concrete|property|disaster|\bdki\b|damage|abatement|remediation contractor|fire & flood|water damage/i;
const isBuildingResto = j =>
  /restoration/i.test(j.title) && !/ecolog|habitat|wetland|stream|shoreline|riparian|ecosystem|land|native|forest/i.test(j.title + " " + (j.summary || ""))
  && BUILDING_RESTO.test(j.org);

// filter
const todayStr = new Date().toISOString().slice(0, 10);
// Canadian-only boards (WorkCabin, City of Toronto, U of T) often give a bare city ("Guelph")
// with no province — skip the "is this in Canada?" text check for them.
const canadaOnly = new Set(cfg.sources.filter(s => s.assume_canada).map(s => s.source_name || s.id));
// A posting known to still be open (future closing date, or a board that removes expired
// listings) may be older than the 7-day cap — up to OPEN_MAX_DAYS.
const OPEN_MAX_MS = (cfg.max_days_open || 60) * 86400000;
const fresh = j => ageOK(j.posted)
  || (j.stillOpen && (now - new Date(j.posted).getTime()) <= OPEN_MAX_MS);
let jobs = all.filter(j =>
  j.url && j.title && j.posted && fresh(j)
  && wantedCats.has(j.category)
  && !TITLE_BLOCK.test(j.title)
  && !TITLE_BLOCK_2.test(j.title)
  && !isITJob(j.title)
  && !isBuildingResto(j)
  && (canadaOnly.has(j.source) || looksCanadian(j.location, j.summary || ""))
  && !(j.closingDate && j.closingDate < todayStr)   // drop postings past their stated closing date
);

// dedupe: by normalized URL, then by title+org
const seen = new Set();
// Drop the query string (tracking params) — unless the job id lives there (GC Jobs ?poster=N).
const urlKey = u => /[?&](poster|jobid)=/i.test(u) ? u.toLowerCase() : u.split("?")[0].toLowerCase();
jobs = jobs.filter(j => {
  const k1 = urlKey(j.url);
  const k2 = (j.title + "@" + j.org).toLowerCase().replace(/\s+/g, "");
  if (seen.has(k1) || seen.has(k2)) return false;
  seen.add(k1); seen.add(k2);
  return true;
});

jobs.sort((a, b) => new Date(b.posted) - new Date(a.posted));

/* ------------------- qualification check ------------------- */
// Interest-matching (keywords) says "this is the kind of job I want"; this says "can I
// actually get it?". For each kept job, read the full posting (fetching the job page when
// the source only gave a title) and look for hard requirements the owner doesn't meet —
// see cfg.profile. fit = "yes" | "check" | "no" | "unknown", with plain-English fitWhy.

const ASSET_RE = /\b(asset|assets|preferred|preference|ideal(ly)?|nice to have|an advantage|a plus|bonus|desirable|would be beneficial)\b/i;
const NEED_RE = /\b(requir\w*|must|essential|mandatory|minimum|need(ed|s)?|qualifications?|hold|possess|valid|registered|registration|in good standing|eligib\w+)\b/i;
const sentences = t => t.split(/(?<=[.;!?•])\s+|\s[-–•*]\s|\s{2,}/).filter(s => s.length > 3);

// Credentials the owner does NOT hold (sources.json "profile" lists what he does have).
// [case-insensitive phrases, case-sensitive acronyms (so "Oct 15" isn't OCT), what to say]
const CREDS = [
  [/\bp\.\s?eng\b|professional engineer|engineer[- ]in[- ]training/i, /\bP\.?Eng\b|\bEIT\b/, "a P.Eng / EIT engineering licence"],
  [/\bp\.\s?geo\b|professional geoscientist/i, /\bP\.?Geo\b/, "a P.Geo licence"],
  [/registered professional forester/i, /\bRPF\b/, "RPF (registered forester) status"],
  [/\bp\.\s?ag\b|professional agrologist/i, /\bP\.?Ag\b/, "P.Ag (agrologist) registration"],
  [/college of medical laboratory technologists|registered medical laboratory technologist/i, /\bCMLTO\b|\bCSMLS\b/, "CMLTO / CSMLS medical-lab registration"],
  [/ontario college of teachers|ontario certified teacher|certified teacher|teaching (licen[cs]e|certificate)/i, /\bOCT\b/, "Ontario College of Teachers certification (you're still working on it)"],
  [/certified arborist|isa certification/i, null, "ISA Certified Arborist status"],
  [/registered early childhood educator/i, /\bRECE\b/, "RECE (early childhood) registration"],
  [/certificate in public health inspection/i, /\bCPHI\(C\)/, "the CPHI(C) public-health inspector certificate"],
  [/registered nurse|chartered professional accountant|certified engineering technologist/i, /\bCPA\b|\bC\.E\.T\./, "a professional designation you don't hold"],
];
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function yearsRequired(t) {
  let max = 0;
  const take = (n, at, len) => {
    const ctx = t.slice(Math.max(0, at - 90), at + len + 70);
    if (ASSET_RE.test(ctx)) return;                      // "3 years … is an asset"
    if (/\d\s*(-|–|to)\s*$/.test(t.slice(Math.max(0, at - 5), at))) return;   // a range like "0-5 years"
    if (n > max && n < 20) max = n;
  };
  for (const m of t.matchAll(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\(\d+\)\s*)?(?:\+|or more|plus)?\s*(?:years?|yrs?)\b[^.;]{0,50}?\bexperience/gi))
    take(NUMW[m[1].toLowerCase()] ?? +m[1], m.index, m[0].length);
  // Job Bank's structured field: "Experience 2 years to less than 3 years" / "5 years or more"
  for (const m of t.matchAll(/experience:?\s*(\d{1,2}) years? (?:to less than|or more)/gi))
    take(+m[1], m.index, m[0].length);
  return max;
}

function assessFit(j) {
  const t = j._text || "";
  const title = j.title;
  const no = [], check = [], plus = [];
  const P = cfg.profile || {};

  // --- from the title alone ---
  if (/post-?doc/i.test(title)) no.push("needs a completed PhD");
  if (/\b(supply|occasional|lto)\b.{0,20}\bteacher|\bteacher\b.{0,20}\b(supply|occasional)\b/i.test(title))
    no.push("Ontario school-board teaching needs OCT certification (you're still working on it)");
  if (/medical laboratory technologist/i.test(title) && !/assistant|technician/i.test(title))
    no.push("medical lab technologist roles need CMLTO registration");
  if (/\bstudent\b/i.test(title) && /GC Jobs|University of Toronto/.test(j.source))
    no.push("only open to current students");
  if (/\b(co-?op|summer student|internship)\b/i.test(title) && !t) check.push("often only open to current students");
  if (/educational assistant|education assistant/i.test(title))
    check.push("school boards usually ask for an EA / ECE college certificate");

  // --- from the posting text ---
  if (t) {
    const recruitingStudents = /ph\.?d\.? (position|studentship|opportunit|project|candidate)|graduate (student )?position|m\.?sc\.? (position|opportunit)|funded/i.test(title);
    if (!recruitingStudents && /full[- ]time student status|must be (a )?(currently )?(registered|enrolled)|currently enrolled|be enrolled (as a )?(full|in a|in an)|returning to (full[- ]time )?(studies|school)|must be a (full[- ]time )?student/i.test(t))
      no.push("only open to current students");
    if (/(completed|hold|holds|possess|possession of) (a |an )?(ph\.?\s?d|doctora)|(ph\.?\s?d\.?|doctoral degree|doctorate)\b[^.]{0,40}\b(is )?(required|essential)/i.test(t))
      no.push("needs a PhD");
    for (const s of sentences(t)) {
      if (ASSET_RE.test(s) || !NEED_RE.test(s)) continue;
      for (const [ci, cs, what] of CREDS) if (ci.test(s) || (cs && cs.test(s))) no.push("asks for " + what);
      if (/canadian citizen(ship)?\b/i.test(s) && !/permanent resident/i.test(s)) no.push("requires Canadian citizenship (you're a permanent resident)");
    }
    // (GC Jobs boilerplate "Selection MAY be limited to members of … equity groups" is not a restriction)
    if (/(?<!may be )(open|restricted|limited) (only )?to (indigenous|first nations|members of (the following )?(designated )?employment equity)|self-identify as (an )?indigenous[^.]{0,40}(required|must)/i.test(t))
      no.push("restricted to an employment-equity group");
    const res = t.match(/persons? (?:residing|living)(?: or employed)? (?:in|within) ([^.;]{3,140})/i)
      || t.match(/must (?:reside|live) within ([^.;]{3,100})/i);
    if (res && !/\b(canada|ontario|toronto|gta|greater toronto)\b/i.test(res[1]))
      no.push("only open to people already living in " + res[1].replace(/\s*(who|and|,).*$/i, "").slice(0, 60));
    const yrs = yearsRequired(t);
    const have = P.years_experience || 4;
    if (yrs > have + 1) no.push(`asks for ${yrs}+ years of experience`);
    else if (yrs >= Math.max(3, have - 1)) check.push(`asks for ${yrs} years of experience — count your lab, GIS and field years`);
    if (/\b(bilingual|french)\b/i.test(t)) plus.push("French / bilingual — a plus for you");
  }

  const uniq = a => [...new Set(a)];
  if (no.length) return { fit: "no", fitWhy: uniq(no) };
  if (check.length) return { fit: "check", fitWhy: uniq(check) };
  if (!t || t.length < 300) return { fit: "unknown", fitWhy: ["couldn't read the requirements — open the posting"] };
  return { fit: "yes", fitWhy: uniq(plus) };
}

// Fetch the job page for postings whose source only gave a title / short blurb.
async function detailText(j) {
  const u = j.id.startsWith("adzuna-") ? "https://www.adzuna.ca/details/" + j.id.slice(7) : j.url;
  const r = await fetch(u, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(r.status);
  const h = await r.text();
  // Skip GC Jobs' "You will leave the GC Jobs Web site" stub pages.
  if (/You will leave the GC Jobs Web site/.test(h)) return "";
  return stripTags(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/gi, " ")).slice(0, 30000);
}
{
  const need = jobs.filter(j => (j._text || "").length < 600).slice(0, cfg.fit_max_fetch || 250);
  let i = 0, ok = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < need.length) {
      const j = need[i++];
      try { const t = await detailText(j); if (t.length > (j._text || "").length) { j._text = t; ok++; } }
      catch (e) { /* keep what we have */ }
    }
  }));
  console.log(`Qualification check: read ${ok}/${need.length} job pages`);
  for (const j of jobs) Object.assign(j, assessFit(j));
  const byFit = jobs.reduce((m, j) => (m[j.fit] = (m[j.fit] || 0) + 1, m), {});
  console.log("  by fit:", byFit);
}
for (const j of jobs) delete j._text;

console.log(`Kept ${jobs.length} after filter + dedupe`);
const byCat = jobs.reduce((m, j) => (m[j.category] = (m[j.category] || 0) + 1, m), {});
const bySrc = jobs.reduce((m, j) => (m[j.source] = (m[j.source] || 0) + 1, m), {});
console.log("  by field:", byCat);
console.log("  by source:", bySrc);

// fold final kept-count per source into the status rows
for (const s of status) s.kept = jobs.filter(j => j.source === s.name).length;

const output = { generated: new Date().toISOString(), count: jobs.length, sources: status, jobs };
await writeFile(join(ROOT, "data", "jobs.json"), JSON.stringify(output, null, 1) + "\n");
console.log("\nWrote data/jobs.json");
console.table(status.map(s => ({ source: s.name, state: s.state, kept: s.kept })));

if (jobs.length === 0) {
  console.log("WARNING: zero jobs kept. Check source config / API keys before relying on this.");
}

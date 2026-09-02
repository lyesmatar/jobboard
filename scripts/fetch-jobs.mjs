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
async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const stripTags = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;|&apos;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").trim();

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

function normalize(raw) {
  const blob = `${raw.title} ${raw.org} ${raw.summary || ""} ${raw.location || ""}`;
  // Categorize on the TITLE (+ description) only — NOT the employer name, which throws
  // false positives like "helper, mason" @ "Concrete Restoration Canada".
  const catBlob = `${raw.title} ${raw.summary || ""}`;
  const sal = (raw.salaryMin || raw.salaryMax) ? raw
    : { ...raw, ...parseSalary(raw.salaryText || raw.summary) };
  return {
    id: raw.id,
    title: stripTags(raw.title).slice(0, 200),
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
    closingDate: raw.closingDate || parseClosing(raw.summary) || null,
    vehicleRequired: raw.vehicleRequired ?? needsOwnVehicle(blob),
    tenure: raw.tenure || tenure(blob, raw.employmentType),
    summary: stripTags(raw.summary || "").slice(0, 600) || null,
  };
}

// Pull a "closing date" / "apply by" date out of free text, if present.
function parseClosing(text) {
  if (!text) return null;
  const m = String(text).match(/(?:closing date|closes on|apply by|application deadline|deadline|posting expires on)[:\s]*([A-Za-z]+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
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
    return normalize({
      id: sourceName + "-" + (tag(it, "guid") || tag(it, "link")),
      title: tag(it, "title"),
      org: sourceName,
      location: tag(it, "location") || "",
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
const TITLE_BLOCK = /\b(counsel|lawyer|paralegal|attorney|accountant|accounting|bookkeeper|payroll|auditor|actuary|underwriter|sales representative|account executive|business development|marketing manager|recruiter|talent acquisition|realtor|real estate|insurance broker|financial advisor|loan officer|barista|cashier|server|dishwasher|line cook|warehouse associate|forklift|truck driver|delivery driver|heavy duty (mechanic|technician)|heavy equipment|\bmechanic\b|millwright|welder|electrician|plumber|hvac|roofer|carpenter|mason|nurse|physician|pharmacist|dental|veterinari|paramedic|personal support worker|\bpsw\b)\b/i;

// "restoration" also means building/damage/disaster restoration — exclude those by employer.
const BUILDING_RESTO = /building|masonry|concrete|property|disaster|\bdki\b|damage|abatement|remediation contractor|fire & flood|water damage/i;
const isBuildingResto = j =>
  /restoration/i.test(j.title) && !/ecolog|habitat|wetland|stream|shoreline|riparian|ecosystem|land|native|forest/i.test(j.title + " " + (j.summary || ""))
  && BUILDING_RESTO.test(j.org);

// filter
const todayStr = new Date().toISOString().slice(0, 10);
let jobs = all.filter(j =>
  j.url && j.title && j.posted && ageOK(j.posted)
  && wantedCats.has(j.category)
  && !TITLE_BLOCK.test(j.title)
  && !isBuildingResto(j)
  && looksCanadian(j.location, j.summary || "")
  && !(j.closingDate && j.closingDate < todayStr)   // drop postings past their stated closing date
);

// dedupe: by normalized URL, then by title+org
const seen = new Set();
const key = j => (j.url.split("?")[0].toLowerCase()) + "|" + j.title.toLowerCase().slice(0, 40);
jobs = jobs.filter(j => {
  const k1 = j.url.split("?")[0].toLowerCase();
  const k2 = (j.title + "@" + j.org).toLowerCase().replace(/\s+/g, "");
  if (seen.has(k1) || seen.has(k2)) return false;
  seen.add(k1); seen.add(k2);
  return true;
});

jobs.sort((a, b) => new Date(b.posted) - new Date(a.posted));

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

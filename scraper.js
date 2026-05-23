// ═══════════════════════════════════════════════════════════════════
// KAVYA JOB BOARD — LIVE MULTI-SOURCE SCRAPER
// Runs daily via GitHub Actions → posts to backend API
//
// Architecture:
//   1. Scrape real HTML from 30+ live sources in parallel
//   2. Score & filter every result against Kavya's strict profile
//   3. Deduplicate across sources by title + org fingerprint
//   4. Post LIVE jobs to API  (source: 'live')
//   5. Only if ALL scraping fails → post curated fallback (source: 'fallback')
//      Fallback jobs are clearly flagged and never counted as "new"
// ═══════════════════════════════════════════════════════════════════

const axios  = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT = 12000; // ms per fetch
const MAX_JOBS_PER_SOURCE = 25;
const MAX_JOBS_PER_ORG    = 3;   // Fix 6: cap per institution after scoring
const MIN_SCORE_THRESHOLD = 48;  // combined title+description threshold
const MIN_TITLE_SCORE     = 20;  // Fix 2: title must score at least this alone — "PhD position at VU Amsterdam" scores ~19, correctly below this
const MIN_DESC_LENGTH     = 60;  // Fix 4: descriptions shorter than this get penalised
const TARGET_LIVE_JOBS    = 15;

// Fix 3: Disciplines that are irrelevant by TITLE alone.
// Only checked against the title string — never the description —
// so a bio job that mentions maths/physics in its body is unaffected.
const TITLE_DISCIPLINE_EXCLUDE = [
  // Pure mathematics / formal sciences
  'number theory', 'mathematics', 'algebraic', 'topology', 'combinatorics',
  'graph theory', 'calculus', 'statistics phd', 'mathematical model',
  // Physics / astronomy
  'astrophysics', 'astronomy', 'astrobiology', 'cosmology', 'quantum',
  'particle physics', 'nuclear physics', 'optics phd', 'photonics phd',
  'condensed matter', 'plasma physics',
  // Earth / environmental sciences (non-biology)
  'geology', 'geophysics', 'hydrology', 'hydrogeology', 'seismology',
  'oceanography', 'atmospheric science', 'climatology', 'meteorology',
  'groundwater', 'sedimentology', 'geochemistry', 'petrology',
  // Engineering (non-biomedical)
  'electrical engineering', 'mechanical engineering', 'civil engineering',
  'structural engineering', 'aerospace engineering', 'chemical engineering phd',
  'materials science phd', 'robotics phd', 'control systems',
  // Humanities / social sciences
  'philosophy', 'sociology', 'anthropology', 'archaeology', 'history phd',
  'linguistics', 'literature phd', 'political science', 'economics phd',
  'islamic', 'theology', 'religious studies', 'cultural studies',
  // Marine / ecology (unless biology-adjacent)
  'coral reef', 'marine ecology', 'fisheries', 'aquaculture phd',
  'forest ecology', 'plant ecology phd', 'entomology phd',
  // Computer science (pure)
  'computer science phd', '6g ', 'big data phd', 'cybersecurity phd',
  'information systems phd', 'human-computer interaction',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'Referer': 'https://www.google.com/',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const JSON_HEADERS = {
  ...HEADERS,
  'Accept': 'application/json,text/plain,*/*',
  'X-Requested-With': 'XMLHttpRequest',
};

const HISTORY_FILE = process.env.HISTORICAL_JOBS_PATH
  || path.join(process.cwd(), '.scraper-history.json');

const PLAYWRIGHT_TIMEOUT = Number(process.env.PLAYWRIGHT_TIMEOUT || 25000);
let chromium = null;
let playwrightChecked = false;
let browserPromise = null;

// ─── KAVYA'S PROFILE ─────────────────────────────────────────────────────────

const STRONG_KEYWORDS = [
  // Core competencies (highest weight)
  { kw: 'stem cell',              w: 18 },
  { kw: 'embryonic stem',         w: 20 },
  { kw: 'hesc',                   w: 20 },
  { kw: 'esc',                    w: 15 },
  { kw: 'pluripoten',             w: 18 },
  { kw: 'epigeneti',              w: 16 },
  { kw: 'dna methylation',        w: 16 },
  { kw: 'immunology',             w: 15 },
  { kw: 'immunofluorescence',     w: 14 },
  { kw: 'microbiology',           w: 13 },
  { kw: 'cell culture',           w: 13 },
  { kw: 'mammalian cell',         w: 13 },
  { kw: 'cell biology',           w: 11 },
  { kw: 'molecular biology',      w: 12 },
  { kw: 'qpcr',                   w: 13 },
  { kw: 'rt-qpcr',                w: 14 },
  { kw: 'pcr',                    w:  8 },
  { kw: 'flow cytometry',         w: 12 },
  { kw: 'elisa',                  w: 10 },
  { kw: 'western blot',           w:  9 },
  { kw: 'confocal',               w: 10 },
  { kw: 'fluorescence microscopy',w: 11 },
  { kw: 'neurodegener',           w: 12 },
  { kw: 'neurodegeneration',      w: 14 },
  { kw: 'neuroscience',           w: 10 },
  { kw: 'organoid',               w: 14 },
  { kw: 'regenerative medicine',  w: 15 },
  { kw: 'caco-2',                 w: 14 },
  { kw: 'sh-sy5y',                w: 16 },
  { kw: 'glp',                    w: 10 },
  { kw: 'qa/qc',                  w: 10 },
  { kw: 'quality control',        w:  8 },
  { kw: 'atmp',                   w: 12 },
  { kw: 'cell therapy',           w: 14 },
  { kw: 'epigenomics',            w: 15 },
  { kw: 'chromatin',              w: 12 },
  { kw: 'histone',                w: 11 },
  { kw: 'gene expression',        w:  9 },
  { kw: 'rna',                    w:  7 },
  { kw: 'mrna',                   w:  8 },
  { kw: 'crispr',                 w: 11 },
  { kw: 'transfection',           w: 10 },
  { kw: 'lentiviral',             w: 10 },
  { kw: 'in vitro',               w:  8 },
  { kw: 'toxicology',             w: 10 },
  { kw: 'neurotoxicology',        w: 14 },
  { kw: 'endocrine disrupt',      w: 12 },
  { kw: 'barrier function',       w: 11 },
  { kw: 'mucosal immunity',       w: 12 },
  // Role types that match Kavya's level
  { kw: 'marie curie',            w: 20 },
  { kw: 'msca',                   w: 18 },
  { kw: 'fully funded',           w: 15 },
  { kw: 'research assistant',     w: 10 },
  { kw: 'research engineer',      w: 10 },
  { kw: 'research technician',    w: 10 },
  { kw: 'lab technician',         w:  9 },
  { kw: 'laboratory technician',  w:  9 },
  { kw: 'associate scientist',    w: 10 },
  { kw: 'junior scientist',       w: 11 },
  { kw: 'phd student',            w: 14 },
  { kw: 'doctoral',               w: 12 },
  { kw: 'phd position',           w: 14 },
  { kw: 'phd candidate',          w: 13 },
  { kw: 'early career',           w:  9 },
  { kw: 'graduate',               w:  7 },
  { kw: 'msc',                    w:  7 },
  { kw: 'masters',                w:  6 },
];

// Hard exclusions — if present, score → -1 (drop job entirely)
// NOTE: Keep this list tight — over-exclusion was causing 274→1 collapse
const HARD_EXCLUDE = [
  'software engineer',
  'software developer',
  'devops engineer',
  'it engineer',
  'nursing',
  'nurse practitioner',
  'postdoctoral fellow',
  'postdoc fellow',
  'post-doctoral fellow',
  'full professor',
  'associate professor',
  'assistant professor',
  'business development manager',
  'sales representative',
  'account manager',
  'account executive',
  'pure inorganic chemistry',
  'veterinary surgeon',
  'animal husbandry only',
  'hr manager',
  'finance manager',
];

// Soft exclusions — reduce score but don't drop
// Penalties are intentionally moderate so borderline jobs land as "stretch" not dropped
const SOFT_EXCLUDE = [
  { kw: 'senior scientist',      penalty: 10 },
  { kw: 'principal scientist',   penalty: 14 },
  { kw: 'director',              penalty: 14 },
  { kw: 'manager',               penalty: 12 },
  { kw: 'head of',               penalty: 15 },
  { kw: 'team lead',             penalty: 10 },
  { kw: 'bioinformatics only',   penalty: 16 },
  { kw: 'bioinformatics',        penalty:  5 }, // soft — might still be relevant lab job
  { kw: 'machine learning only', penalty: 14 },
  { kw: 'machine learning',      penalty:  4 },
  { kw: 'deep learning',         penalty:  4 },
  { kw: 'animal model only',     penalty: 10 },
  { kw: 'data scientist',        penalty: 10 },
  { kw: 'postdoctoral',          penalty: 16 }, // soft so postdoc-adjacent roles survive
  { kw: 'postdoc',               penalty: 14 },
];

// Country → dashboard key
const COUNTRY_MAP = {
  'sweden': 'sweden', 'se': 'sweden', 'svenska': 'sweden',
  'netherlands': 'netherlands', 'nl': 'netherlands', 'holland': 'netherlands',
  'denmark': 'denmark', 'dk': 'denmark', 'danish': 'denmark',
  'germany': 'germany', 'de': 'germany', 'deutschland': 'germany',
  'belgium': 'belgium', 'be': 'belgium',
  'switzerland': 'switzerland', 'ch': 'switzerland',
  'luxembourg': 'luxembourg', 'lu': 'luxembourg',
};

function resolveCountry(raw = '') {
  const l = raw.toLowerCase().trim();
  return COUNTRY_MAP[l] || 'sweden'; // default sweden if unknown
}

// ─── SCORING ENGINE ──────────────────────────────────────────────────────────

// Fix 3: Check title against off-discipline list (title only, never description)
function titleIsOffDiscipline(title = '') {
  const t = title.toLowerCase();
  for (const term of TITLE_DISCIPLINE_EXCLUDE) {
    if (t.includes(term)) return true;
  }
  return false;
}

// Fix 2: Score title in isolation — used as a hard gate before full scoring
function scoreTitleAlone(title = '') {
  const t = title.toLowerCase();
  let s = 0;
  // Hard exclusion on title
  for (const excl of HARD_EXCLUDE) {
    if (t.includes(excl)) return -1;
  }
  // Role type signals in title
  if (/phd|doctoral/.test(t))                              s += 10;
  if (/research\s+(assistant|engineer|scientist|associate|technician)/i.test(t)) s += 10;
  if (/lab(oratory)?\s+(technician|assistant)/i.test(t))  s += 8;
  if (/junior\s+(scientist|researcher|associate)/i.test(t)) s += 8;
  if (/associate\s+scientist/i.test(t))                   s += 8;
  if (/marie\s+curie|msca/i.test(t))                      s += 14;
  // Science / biology keywords in title
  for (const { kw, w } of STRONG_KEYWORDS) {
    if (t.includes(kw)) s += Math.ceil(w * 0.6); // partial weight for title-only match
  }
  return s;
}

function scoreJob(title = '', description = '') {
  // ── Fix 3: title discipline gate (fastest possible rejection) ──
  if (titleIsOffDiscipline(title)) return -1;

  // ── Fix 2: title-alone score gate ──
  const titleScore = scoreTitleAlone(title);
  if (titleScore < 0) return -1; // hard exclusion fired in title

  // Fix 1: Placeholder detection — always reject if the description is the
  // scraper's own fallback text (never real content from the listing).
  const PLACEHOLDER_PATTERN = /live listing from|matches your profile on molecular biology/i;
  if (description && PLACEHOLDER_PATTERN.test(description)) return -1;

  const descIsReal = description
    && description.length >= MIN_DESC_LENGTH
    && !PLACEHOLDER_PATTERN.test(description);

  // Fix 2 continued: Generic title + no real description → reject.
  // e.g. "PhD position at VU Amsterdam" scores titleScore ~10 (no bio keywords)
  // → correctly dropped when there's no description to save it.
  if (titleScore < MIN_TITLE_SCORE && !descIsReal) return -1;

  const text = (title + ' ' + (descIsReal ? description : '')).toLowerCase();

  // Hard exclusion check on combined text
  for (const excl of HARD_EXCLUDE) {
    if (text.includes(excl)) return -1;
  }

  let score = 36; // base

  // Life sciences context bonus
  if (/life science|biolog|biomed|biochem|biotech|pharmaceutical|health|medical|research|laborator/i.test(text)) {
    score += 6;
  }

  // PhD / role boosts
  if (text.includes('phd') || text.includes('doctoral')) score += 14;
  if (text.includes('fully funded') || text.includes('marie curie') || text.includes('msca')) score += 18;
  if (/research\s+(assistant|engineer|scientist|associate|technician)/i.test(text)) score += 10;
  if (/lab(oratory)?\s+(technician|assistant|manager)/i.test(text)) score += 8;
  if (/junior\s+(scientist|researcher|associate)/i.test(text)) score += 9;
  if (/early.career|graduate.programme|trainee|internship/i.test(text)) score += 6;

  // Strong keyword matches
  for (const { kw, w } of STRONG_KEYWORDS) {
    if (text.includes(kw)) score += w;
  }

  // Multi-keyword bonus
  const matchCount = STRONG_KEYWORDS.filter(({ kw }) => text.includes(kw)).length;
  if (matchCount >= 3) score += 8;
  if (matchCount >= 5) score += 6;

  // Fix 4: Thin description penalty — if description was absent or too short,
  // we're scoring on title alone; raise the effective bar.
  if (!descIsReal) score -= 12;

  // Soft exclusion penalties
  for (const { kw, penalty } of SOFT_EXCLUDE) {
    if (text.includes(kw)) score -= penalty;
  }

  return Math.max(0, Math.min(score, 100));
}

function tierFromScore(score) {
  return score >= 76 ? 'high' : score >= 58 ? 'medium' : 'stretch';
}

function typeFromText(text) {
  const t = text.toLowerCase();
  return (t.includes('phd') || t.includes('doctoral')) ? 'phd' : 'industry';
}

// Stable dedup fingerprint (matches the frontend jobKey logic)
function fingerprint(title = '', org = '') {
  return `${org.toLowerCase().replace(/\s+/g, ' ').trim()}||${title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

// Fix 5: Sources that return ALL jobs from an institution (not keyword-filtered)
// need a higher threshold — they produce the "PhD in Astrophysics at VU Amsterdam" noise.
// Keyword-search sources (FindAPhD, EURAXESS, Nature Careers) are trusted at MIN_SCORE_THRESHOLD.
const GENERAL_PORTAL_SOURCES = new Set([
  'dutch', 'swedish', 'danish', 'resteurope', 'academictransfer',
]);
const PORTAL_SCORE_THRESHOLD = 62; // raised bar for general portals

// Build a proper job object from raw fields
// sourceType: 'keyword' (search-result pages) | 'portal' (general university vacancy pages)
function buildJob(raw, source, sourceType = 'keyword') {
  const score = scoreJob(raw.title, raw.description || '');

  // Fix 5: Apply tighter threshold for general portal sources
  const threshold = (sourceType === 'portal' || GENERAL_PORTAL_SOURCES.has(source))
    ? PORTAL_SCORE_THRESHOLD
    : MIN_SCORE_THRESHOLD;

  if (score < threshold) return null;

  const country = resolveCountry(raw.country);
  const type    = raw.type || typeFromText(raw.title + ' ' + (raw.description || ''));
  const tier    = tierFromScore(score);

  // Fix 1: Only use description text that is genuinely from the listing.
  // The PLACEHOLDER_PATTERN check is already done in scoreJob, but we also
  // guard here so the `why` field never shows the placeholder as if it were real.
  const PLACEHOLDER_PATTERN = /live listing from|matches your profile on molecular biology/i;
  const descIsReal = raw.description
    && raw.description.length >= MIN_DESC_LENGTH
    && !PLACEHOLDER_PATTERN.test(raw.description);

  const why = descIsReal
    ? raw.description.replace(/\s+/g, ' ').trim().substring(0, 160) + '…'
    : `Live listing from ${source}. Score: ${score} — title matched Kavya's profile keywords.`;

  const id = `${source}-${fingerprint(raw.title, raw.org).replace(/[^a-z0-9]/g, '-').substring(0, 48)}`;

  return {
    id,
    country,
    tier,
    type,
    org: raw.org || 'Unknown Organisation',
    score,
    title: raw.title,
    tags: buildTags(raw.title, raw.org, country, raw.location),
    why,
    deadline: raw.deadline || '📅 Rolling',
    deadlineWarn: raw.deadlineWarn || false,
    url: raw.url || '#',
    source: 'live',
    fetchedAt: new Date().toISOString(),
    dateFound: new Date().toISOString(), // ISO timestamp of when this job was first discovered
    _fp: fingerprint(raw.title, raw.org),
  };
}

function buildTags(title, org, country, location) {
  const tags = [];
  const t = (title + '').toLowerCase();
  if (t.includes('phd') || t.includes('doctoral')) tags.push('🎓 PhD');
  else tags.push('🏢 Industry');
  if (location) tags.push(`📍 ${location}`);
  else {
    const cityMap = {
      sweden: 'Sweden', netherlands: 'Netherlands', denmark: 'Denmark',
      germany: 'Germany', belgium: 'Belgium', switzerland: 'Switzerland', luxembourg: 'Luxembourg'
    };
    tags.push(`📍 ${cityMap[country] || country}`);
  }
  if (t.includes('marie curie') || t.includes('msca')) tags.push('MSCA · Fully Funded');
  else if (t.includes('fully funded')) tags.push('Fully Funded');
  if (t.includes('stem cell')) tags.push('Stem Cells');
  if (t.includes('immunology') || t.includes('immun')) tags.push('Immunology');
  if (t.includes('epigeneti')) tags.push('Epigenetics');
  return tags.slice(0, 5);
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(link = '', base = '') {
  if (!link) return base || '#';
  try {
    return new URL(link, base).toString();
  } catch {
    return link.startsWith('http') ? link : '#';
  }
}

function hostReferer(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return HEADERS.Referer;
  }
}

function pushJob(jobs, raw, defaults = {}) {
  const title = cleanText(raw.title);
  if (!title || title.length < 6) return;
  const baseUrl = defaults.baseUrl || raw.baseUrl || raw.url || '';
  jobs.push({
    title,
    org: cleanText(raw.org || defaults.org || 'Unknown Organisation'),
    country: raw.country || defaults.country || '',
    location: cleanText(raw.location || defaults.location || ''),
    description: cleanText(raw.description || defaults.description || ''),
    type: raw.type || defaults.type,
    deadline: raw.deadline || defaults.deadline,
    deadlineWarn: raw.deadlineWarn || false,
    url: absoluteUrl(raw.url || raw.link || '', baseUrl),
  });
}

function parseJsonSafely(text) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return null;
  }
}

function walkJson(value, visitor, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => walkJson(item, visitor, seen));
  } else {
    Object.values(value).forEach(item => walkJson(item, visitor, seen));
  }
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return '';
}

function jsonValue(value) {
  if (Array.isArray(value)) return value.map(jsonValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return value.name || value.title || value.label || value.city || value.country || '';
  }
  return value || '';
}

function extractJobsFromJson(value, defaults = {}) {
  const jobs = [];
  walkJson(value, obj => {
    const type = String(obj['@type'] || obj.type || obj.contentType || '').toLowerCase();
    const title = firstDefined(obj, [
      'title', 'jobTitle', 'name', 'externalTitle', 'postingTitle', 'displayTitle',
      'positionTitle', 'requisitionTitle',
    ]);
    const href = firstDefined(obj, [
      'url', 'jobUrl', 'externalUrl', 'canonicalPositionUrl', 'positionUrl',
      'absolute_url', 'applyUrl',
    ]);
    const looksLikeJob = type.includes('jobposting')
      || href && /job|career|vacanc|position|phd/i.test(String(href))
      || /job|vacanc|position|phd|doctoral|scientist|research/i.test(String(title));
    if (!title || !looksLikeJob) return;

    const org = jsonValue(firstDefined(obj, [
      'hiringOrganization', 'organization', 'employer', 'company', 'department',
      'institution', 'organisationName',
    ]));
    const location = jsonValue(firstDefined(obj, [
      'jobLocation', 'location', 'locations', 'city', 'workLocation',
    ]));
    const country = jsonValue(firstDefined(obj, ['country', 'countryCode']));
    const description = jsonValue(firstDefined(obj, [
      'description', 'summary', 'jobAbstract', 'teaser', 'shortDescription',
    ]));
    const deadline = jsonValue(firstDefined(obj, [
      'validThrough', 'applicationDeadline', 'deadline', 'endDate',
    ]));

    pushJob(jobs, {
      title: jsonValue(title),
      org,
      location,
      country,
      description,
      url: jsonValue(href),
      deadline: deadline ? `📅 ${deadline}` : undefined,
      type: defaults.type,
    }, defaults);
  });
  return deduplicateRawJobs(jobs);
}

function extractEmbeddedJobs(html, defaults = {}) {
  const jobs = [];
  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_, el) => {
    const data = parseJsonSafely($(el).contents().text());
    if (data) jobs.push(...extractJobsFromJson(data, defaults));
  });

  $('script').each((_, el) => {
    const text = $(el).contents().text();
    if (!text || !/(JobPosting|jobTitle|jobs|vacancies|positions)/i.test(text)) return;
    const nextMatch = text.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    const jsonText = nextMatch ? nextMatch[1] : null;
    if (jsonText) {
      const data = parseJsonSafely(jsonText);
      if (data) jobs.push(...extractJobsFromJson(data, defaults));
    }
  });

  const nextData = $('#__NEXT_DATA__').contents().text();
  if (nextData) {
    const data = parseJsonSafely(nextData);
    if (data) jobs.push(...extractJobsFromJson(data, defaults));
  }

  return deduplicateRawJobs(jobs);
}

function parseHtmlCards(html, defaults, selectors) {
  const jobs = [];
  const $ = cheerio.load(html);
  const cardSelector = selectors.card || 'article, li, .job, .vacancy, .position';
  $(cardSelector).each((_, el) => {
    const title = cleanText($(el).find(selectors.title || 'h1, h2, h3, a, [class*="title"]').first().text());
    const link = $(el).find(selectors.link || 'a[href]').first().attr('href') || '';
    const org = cleanText($(el).find(selectors.org || '[class*="employer"], [class*="company"], [class*="organisation"], [class*="organization"], [class*="institution"], [class*="university"]').first().text());
    const location = cleanText($(el).find(selectors.location || '[class*="location"], [class*="country"], [class*="place"]').first().text());
    const description = cleanText($(el).find(selectors.description || 'p, [class*="summary"], [class*="description"], [class*="teaser"]').first().text());
    const deadline = cleanText($(el).find(selectors.deadline || '[class*="deadline"], time').first().text());
    if (title && (link || /phd|doctoral|scientist|research|assistant|engineer/i.test(title))) {
      pushJob(jobs, {
        title, org, location, description, url: link,
        deadline: deadline ? `📅 ${deadline}` : undefined,
      }, defaults);
    }
  });
  return deduplicateRawJobs(jobs);
}

function parseRssItems(xml, defaults = {}) {
  const jobs = [];
  const $ = cheerio.load(xml, { xmlMode: true });
  $('item, entry').each((_, el) => {
    pushJob(jobs, {
      title: $(el).find('title').first().text(),
      org: $(el).find('author name, author, source').first().text(),
      description: $(el).find('description, summary, content').first().text(),
      url: $(el).find('link').first().attr('href') || $(el).find('link').first().text() || $(el).find('guid').first().text(),
      deadline: $(el).find('validThrough, deadline').first().text(),
    }, defaults);
  });
  return jobs;
}

function deduplicateRawJobs(jobsArr) {
  const seen = new Set();
  return jobsArr.filter(j => {
    const key = `${cleanText(j.title).toLowerCase()}||${cleanText(j.org).toLowerCase()}||${cleanText(j.url).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Safe fetch wrapper — never throws
async function safeFetch(url, opts = {}) {
  try {
    const res = await axios.get(url, {
      timeout: opts.timeout || REQUEST_TIMEOUT,
      headers: {
        ...HEADERS,
        Referer: opts.referer || hostReferer(url),
        ...(opts.json ? JSON_HEADERS : {}),
        ...(opts.headers || {}),
      },
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
    });
    return res.data;
  } catch (e) {
    const status = e.response?.status ? `HTTP ${e.response.status}` : e.message;
    console.warn(`  ⚠ Fetch failed [${url.substring(0, 95)}]: ${status}`);
    return null;
  }
}

async function safePost(url, body, opts = {}) {
  try {
    const res = await axios.post(url, body, {
      timeout: opts.timeout || REQUEST_TIMEOUT,
      headers: {
        ...JSON_HEADERS,
        Referer: opts.referer || hostReferer(url),
        ...(opts.headers || {}),
      },
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
    });
    return res.data;
  } catch (e) {
    const status = e.response?.status ? `HTTP ${e.response.status}` : e.message;
    console.warn(`  ⚠ Post failed [${url.substring(0, 95)}]: ${status}`);
    return null;
  }
}

function getChromium() {
  if (playwrightChecked) return chromium;
  playwrightChecked = true;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.warn('  ⚠ Playwright not installed; protected sources will use axios-only fallback');
    chromium = null;
  }
  return chromium;
}

async function getBrowser() {
  const pwChromium = getChromium();
  if (!pwChromium) return null;
  if (!browserPromise) {
    browserPromise = pwChromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  try {
    return await browserPromise;
  } catch (e) {
    browserPromise = null;
    console.warn(`  ⚠ Playwright browser launch failed: ${e.message}`);
    return null;
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (e) {
    console.warn(`  ⚠ Could not close Playwright browser: ${e.message}`);
  } finally {
    browserPromise = null;
  }
}

async function renderPageHtml(url, opts = {}) {
  let context;
  try {
    const browser = await getBrowser();
    if (!browser) return null;
    context = await browser.newContext({
      userAgent: HEADERS['User-Agent'],
      locale: 'en-GB',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: {
        Accept: HEADERS.Accept,
        'Accept-Language': HEADERS['Accept-Language'],
        Referer: opts.referer || hostReferer(url),
      },
    });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeout || PLAYWRIGHT_TIMEOUT,
      referer: opts.referer || hostReferer(url),
    });
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: opts.waitTimeout || 10000 }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(opts.settleMs || 1200);
    return await page.content();
  } catch (e) {
    console.warn(`  ⚠ Playwright render failed [${url.substring(0, 95)}]: ${e.message}`);
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function parseProtectedPage(url, defaults, selectors, opts = {}) {
  const jobs = [];
  const html = await safeFetch(url, { referer: opts.referer });
  if (html) {
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, selectors));
  }

  const minRenderedFallback = opts.minRenderedFallback ?? 2;
  if (jobs.length >= minRenderedFallback) return jobs;

  console.log(`  ↳ Rendering protected page with Playwright: ${url.substring(0, 80)}`);
  const renderedHtml = await renderPageHtml(url, {
    referer: opts.referer,
    waitForSelector: opts.waitForSelector || selectors?.link || selectors?.card,
  });
  if (!renderedHtml) return jobs;

  const renderedJobs = [
    ...extractEmbeddedJobs(renderedHtml, defaults),
    ...parseHtmlCards(renderedHtml, defaults, selectors),
  ];
  return deduplicateRawJobs([...jobs, ...renderedJobs]);
}

// ─── SOURCE SCRAPERS ─────────────────────────────────────────────────────────
// Each returns an array of raw job objects { title, org, country, description, url, ... }
// buildJob() normalises + scores them later.

// ── 1. EURAXESS (HTML scrape with rate-limit-safe delays) ────────────────────
// NOTE: The RSS endpoint /jobs/search/rss returns 404 — it does NOT exist.
// The API endpoint /api/jobs/search returns 404 — it does NOT exist.
// The only working surface is: https://euraxess.ec.europa.eu/jobs/search
// Rate limiting (429) fired when making 16+ requests rapidly — add delays.
async function scrapeEuraxess() {
  const jobs = [];

  // ── Strategy A: HTML keyword searches with delay between requests ──
  // Confirmed working URL: https://euraxess.ec.europa.eu/jobs/search?keywords=X
  const queries = [
    'stem cell immunology',
    'epigenetics molecular biology',
    'cell culture phd',
    'immunology phd sweden',
    'molecular biology phd',
    'marie curie life sciences',
    'msca doctoral fellowship',
    'regenerative medicine phd',
  ];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const htmlUrl = `https://euraxess.ec.europa.eu/jobs/search?keywords=${encodeURIComponent(q)}`;
    const html = await safeFetch(htmlUrl, { referer: 'https://euraxess.ec.europa.eu/jobs/search' });
    if (html) {
      const defaults = { org: 'EURAXESS', country: 'sweden', baseUrl: htmlUrl };
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, {
        card: '.job-result, .views-row, article.job, article, li[class*="result"], li[class*="job"]',
        link: 'a[href*="/jobs/"], a[href]',
        title: 'h3, h2, [class*="title"], a',
        org: '.organisation-name, [class*="organisation"], [class*="organization"], [class*="employer"]',
        location: '.country, .location, [class*="country"], [class*="location"]',
        description: '.field-name-body, .job-description, p, [class*="description"]',
      }));
    }
    // Delay every 3 requests to avoid 429 rate limiting
    if (i > 0 && i % 3 === 0) await new Promise(r => setTimeout(r, 2000));
  }

  // ── Strategy B: Main listing page (no keyword filter — all recent jobs) ──
  const mainHtml = await safeFetch('https://euraxess.ec.europa.eu/jobs/search', {
    referer: 'https://euraxess.ec.europa.eu/',
  });
  if (mainHtml) {
    const defaults = { org: 'EURAXESS', country: 'sweden', baseUrl: 'https://euraxess.ec.europa.eu/jobs/search' };
    jobs.push(...extractEmbeddedJobs(mainHtml, defaults));
    jobs.push(...parseHtmlCards(mainHtml, defaults, {
      card: '.job-result, .views-row, article, li[class*="result"]',
      link: 'a[href*="/jobs/"], a[href]',
      title: 'h3, h2, [class*="title"], a',
      org: '.organisation-name, [class*="organisation"], [class*="organization"]',
      location: '.country, .location, [class*="country"]',
      description: '.field-name-body, p, [class*="description"]',
    }));
  }

  // ── Strategy C: Playwright as final fallback (JS-rendered results) ──
  if (jobs.length < 10) {
    const pwUrl = 'https://euraxess.ec.europa.eu/jobs/search?keywords=stem+cell+immunology+phd';
    jobs.push(...await parseProtectedPage(pwUrl,
      { org: 'EURAXESS', country: 'sweden', baseUrl: pwUrl },
      {
        card: 'article, li, [class*="job"], [class*="result"], [class*="vacancy"]',
        link: 'a[href*="/jobs/"], a[href]',
        title: 'h3, h2, [class*="title"], a',
        org: '[class*="organisation"], [class*="organization"], [class*="employer"]',
        location: '[class*="country"], [class*="location"]',
        description: 'p, [class*="description"]',
      },
      { referer: 'https://euraxess.ec.europa.eu/', waitForSelector: 'article, li, [class*="job"]' }
    ));
  }

  const out = deduplicateRawJobs(jobs).slice(0, MAX_JOBS_PER_SOURCE * 3);
  console.log(`  EURAXESS: ${out.length} raw candidates`);
  return out;
}

// ── 2. ACADEMIC POSITIONS ─────────────────────────────────────────────────────
// NOTE: academicpositions.com returns 403 on all direct fetches and Playwright
// is defeated by their bot detection (yields only 1 candidate from 20+ attempts).
// Strategy: use their sitemap/feed endpoints which have no bot protection,
// plus jobrxiv.org (aggregates same content, much more accessible).
async function scrapeAcademicPositions() {
  const jobs = [];

  // ── Strategy A: jobrxiv.org — aggregates academic positions, easily scraped ──
  const jobrxivQueries = [
    'stem cell immunology', 'epigenetics molecular biology', 'cell culture phd',
    'immunology phd sweden', 'molecular biology phd netherlands',
    'cell biology phd denmark', 'neuroscience phd', 'regenerative medicine',
    'marie curie', 'msca doctoral',
  ];
  for (const q of jobrxivQueries) {
    const url = `https://jobrxiv.org/job/?search=${encodeURIComponent(q)}`;
    const html = await safeFetch(url, { referer: 'https://jobrxiv.org/' });
    if (!html) continue;
    const defaults = { baseUrl: url, country: 'sweden' };
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, {
      card: 'article, .job-item, li, .result, [class*="job"]',
      title: 'h2, h3, a, .entry-title, [class*="title"]',
      link: 'a[href*="/job/"], a[href]',
      org: '[class*="company"], [class*="employer"], [class*="institution"], [class*="university"]',
      location: '[class*="location"], [class*="country"], [class*="city"]',
      description: 'p, [class*="description"], [class*="excerpt"], [class*="summary"]',
    }));
  }

  // ── Strategy B: academicpositions.com RSS/sitemap (no bot protection) ──
  const apRssUrls = [
    'https://academicpositions.com/rss/jobs.xml',
    'https://academicpositions.com/rss/phd.xml',
    'https://academicpositions.com/sitemap-jobs.xml',
  ];
  for (const rssUrl of apRssUrls) {
    const xml = await safeFetch(rssUrl, {
      headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.7' },
      referer: 'https://academicpositions.com/',
    });
    if (xml) {
      jobs.push(...parseRssItems(xml, { country: 'sweden', baseUrl: 'https://academicpositions.com' }));
      jobs.push(...extractEmbeddedJobs(xml, { country: 'sweden', baseUrl: 'https://academicpositions.com' }));
    }
  }

  // ── Strategy C: Single Playwright attempt on main listing (not all URLs) ──
  // Dramatically reduced from 20+ URLs to 2 — if bot detection fires, fail fast
  for (const url of [
    'https://academicpositions.com/find-jobs/phd/biological-sciences',
    'https://academicpositions.com/find-jobs?q=stem+cell+immunology+phd',
  ]) {
    const defaults = { baseUrl: url, country: 'sweden' };
    jobs.push(...await parseProtectedPage(url, defaults, {
      card: 'article, [class*="JobCard"], [class*="job-card"], li[class*="job"]',
      title: 'h2, h3, [class*="title"], a',
      link: 'a[href*="/ad/"], a[href]',
      org: '[class*="employer"], [class*="university"], [class*="institution"]',
      location: '[class*="location"], [class*="country"]',
      description: 'p, [class*="description"], [class*="summary"]',
    }, {
      referer: 'https://academicpositions.com/',
      waitForSelector: 'article, [class*="JobCard"], a[href*="/ad/"]',
    }));
  }

  const out = deduplicateRawJobs(jobs).slice(0, MAX_JOBS_PER_SOURCE * 3);
  console.log(`  Academic Positions: ${out.length} raw candidates`);
  return out;
}

// ── 3. ACADEMIC TRANSFER ─────────────────────────────────────────────────────
async function scrapeAcademicTransfer() {
  const jobs = [];
  const urls = [
    'https://www.academictransfer.com/en/jobs/?q=stem+cell&domain=&countries=SE,NL,DE,BE,CH,LU,DK',
    'https://www.academictransfer.com/en/jobs/?q=immunology+phd&countries=SE,NL,DE,BE,CH,LU,DK',
    'https://www.academictransfer.com/en/jobs/?q=epigenetics&countries=SE,NL,DE,BE,CH,LU,DK',
    'https://www.academictransfer.com/en/jobs/?q=molecular+biology+research+engineer',
  ];

  for (const url of urls) {
    const html = await safeFetch(url);
    if (!html) continue;
    const $ = cheerio.load(html);

    $('.job-listing, article.vacancy, .vacancy-card, li[class*="vacancy"]').each((_, el) => {
      const title = $(el).find('h2, h3, .vacancy-title, [class*="title"]').first().text().trim();
      const org   = $(el).find('.employer, .university, [class*="employer"]').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      const desc  = $(el).find('p, .description').first().text().trim();
      const loc   = $(el).find('.country, .location').first().text().trim();
      if (title && title.length > 5) {
        jobs.push({
          title, org,
          country: resolveCountry(loc) || 'netherlands',
          location: loc,
          description: desc,
          url: link.startsWith('http') ? link : `https://www.academictransfer.com${link}`,
        });
      }
    });
  }
  console.log(`  Academic Transfer: ${jobs.length} raw candidates`);
  return jobs;
}

// ── 4. NATURE CAREERS ────────────────────────────────────────────────────────
async function scrapeNatureCareers() {
  const jobs = [];
  const queries = [
    'stem cell', 'immunology', 'epigenetics', 'molecular biology', 'cell biology',
    'regenerative medicine', 'neuroscience', 'cell culture', 'phd student biology',
  ];

  for (const q of queries) {
    // Europe-scoped search
    const searchUrl = `https://www.nature.com/naturecareers/jobs/science-jobs/europe/?keywords=${encodeURIComponent(q)}`;
    // RSS feed first (most reliable)
    const rssUrl = `${searchUrl}&rss=1`;
    const rss = await safeFetch(rssUrl, {
      headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.7' },
      referer: 'https://www.nature.com/naturecareers/jobs/',
    });
    if (rss) jobs.push(...parseRssItems(rss, {
      org: 'Nature Careers',
      country: 'sweden',
      baseUrl: searchUrl,
    }));

    const html = await safeFetch(searchUrl, { referer: 'https://www.nature.com/naturecareers/jobs/' });
    const defaults = { baseUrl: searchUrl, org: 'Nature Careers', country: 'sweden' };
    if (html) {
      jobs.push(...extractEmbeddedJobs(html, defaults));
      jobs.push(...parseHtmlCards(html, defaults, {
        card: 'li[class*="ResultsList"], article[class*="job"], .job-result, .c-card, li, [data-test*="job"]',
        link: 'a[href*="/naturecareers/job/"], a[href*="/jobs/"], a[href]',
        title: 'h2, h3, [class*="title"], a',
        org: '[class*="employer"], [class*="organisation"], [class*="organization"], [class*="recruiter"], [class*="company"]',
        location: '[class*="location"], [class*="country"]',
        description: 'p, [class*="description"], [class*="summary"]',
      }));
    }
    // Playwright fallback if HTML parsing got nothing
    if (jobs.length < 3) jobs.push(...await parseProtectedPage(searchUrl, defaults, {
      card: 'li[class*="ResultsList"], article[class*="job"], .job-result, .c-card, li',
      link: 'a[href*="/naturecareers/job/"], a[href*="/jobs/"], a[href]',
      org: '[class*="employer"], [class*="organisation"], [class*="organization"], [class*="recruiter"]',
    }, {
      referer: 'https://www.nature.com/naturecareers/jobs/',
      waitForSelector: 'a[href*="/naturecareers/job/"], a[href*="/jobs/"], article, li',
      minRenderedFallback: 1,
    }));
  }
  const out = deduplicateRawJobs(jobs).slice(0, MAX_JOBS_PER_SOURCE * 4);
  console.log(`  Nature Careers: ${out.length} raw candidates`);
  return out;
}

// ── 5. FINDAPHD / jobs.ac.uk ─────────────────────────────────────────────────
// NOTE: findaphd.com blocks ALL access — HTML (403), RSS (403), Playwright (403).
// Completely replaced with jobs.ac.uk which:
//   - Publishes RSS feeds that are freely accessible (no bot detection)
//   - Covers European PhD positions extensively
//   - Lists many of the same positions as FindAPhD
async function scrapeFindAPhD() {
  const jobs = [];

  // ── jobs.ac.uk RSS feeds — confirmed accessible, no bot detection ──
  const jobsAcRssFeeds = [
    // PhD positions in life sciences
    'https://www.jobs.ac.uk/search/rss/?keywords=stem+cell+phd&subject=biological-sciences',
    'https://www.jobs.ac.uk/search/rss/?keywords=immunology+phd&subject=biological-sciences',
    'https://www.jobs.ac.uk/search/rss/?keywords=epigenetics+phd',
    'https://www.jobs.ac.uk/search/rss/?keywords=molecular+biology+phd+europe',
    'https://www.jobs.ac.uk/search/rss/?keywords=cell+biology+phd&subject=biological-sciences',
    'https://www.jobs.ac.uk/search/rss/?keywords=marie+curie+phd+biology',
    'https://www.jobs.ac.uk/search/rss/?keywords=msca+doctoral+life+sciences',
    'https://www.jobs.ac.uk/search/rss/?keywords=neuroscience+phd+europe',
    'https://www.jobs.ac.uk/search/rss/?keywords=regenerative+medicine+phd',
    'https://www.jobs.ac.uk/search/rss/?keywords=cell+culture+research+scientist',
  ];

  for (const rssUrl of jobsAcRssFeeds) {
    const xml = await safeFetch(rssUrl, {
      headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.7' },
      referer: 'https://www.jobs.ac.uk/',
    });
    if (xml) {
      jobs.push(...parseRssItems(xml, {
        org: 'European University',
        country: 'germany', // will be overridden if location is in the RSS item
        type: 'phd',
        baseUrl: 'https://www.jobs.ac.uk/',
      }));
    }
    await new Promise(r => setTimeout(r, 300)); // small delay between RSS requests
  }

  // ── jobs.ac.uk HTML search for European positions ──
  const jobsAcHtmlUrls = [
    'https://www.jobs.ac.uk/search/?keywords=phd+stem+cell+immunology&subject=7',
    'https://www.jobs.ac.uk/search/?keywords=phd+epigenetics+molecular+biology&subject=7',
    'https://www.jobs.ac.uk/search/?keywords=research+assistant+cell+biology',
  ];
  for (const url of jobsAcHtmlUrls) {
    const html = await safeFetch(url, { referer: 'https://www.jobs.ac.uk/' });
    if (!html) continue;
    const defaults = { baseUrl: url, country: 'germany', type: 'phd' };
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, {
      card: 'article, .j-search-result, li[class*="result"], .vacancy',
      title: 'h2, h3, a, .j-search-result__title',
      link: 'a[href*="/jobs/"], a[href]',
      org: '.j-search-result__employer, [class*="employer"], [class*="institution"]',
      location: '[class*="location"], [class*="country"]',
      description: 'p, [class*="description"], [class*="summary"]',
    }));
  }

  // ── Single Playwright attempt on jobs.ac.uk European PhDs ──
  const pwUrl = 'https://www.jobs.ac.uk/search/?keywords=phd+biology+europe&subject=7';
  jobs.push(...await parseProtectedPage(pwUrl,
    { baseUrl: pwUrl, country: 'germany', type: 'phd' },
    {
      card: 'article, .j-search-result, li[class*="result"]',
      title: 'h2, h3, a, .j-search-result__title',
      link: 'a[href*="/jobs/"], a[href]',
      org: '[class*="employer"], [class*="institution"]',
      description: 'p, [class*="description"]',
    },
    { referer: 'https://www.jobs.ac.uk/', waitForSelector: 'article, .j-search-result, li' }
  ));

  const out = deduplicateRawJobs(jobs).slice(0, MAX_JOBS_PER_SOURCE * 4);
  console.log(`  jobs.ac.uk (FindAPhD replacement): ${out.length} raw candidates`);
  return out;
}

// ── 6. UNIVERSITY PORTALS — SWEDEN ───────────────────────────────────────────
async function scrapeSwedishUniversities() {
  const jobs = [];
  const jsPortalSelectors = {
    card: 'article, .job-item, li[class*="job"], .varbi-position, .vacancy, li[class*="result"], [class*="position"]',
    title: 'h2, h3, a, .title, [class*="title"]',
    link: 'a[href]',
    description: 'p, [class*="description"], [class*="summary"]',
  };

  // Uppsala University — Varbi system
  // CONFIRMED URLs (from live search results):
  //   Listing:  https://uu.varbi.com/en/
  //   RSS feed: https://uu.varbi.com/what:rssfeed/
  //   Job page: https://uu.varbi.com/en/what:job/jobID:XXXXXX/
  // The /en/what:job/list/ path does NOT exist — all variants returned 404.

  // Strategy A: RSS feed (most reliable, no bot detection)
  const uuRssUrl = 'https://uu.varbi.com/what:rssfeed/';
  const uuRss = await safeFetch(uuRssUrl, {
    headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.7' },
    referer: 'https://uu.varbi.com/en/',
  });
  if (uuRss) {
    jobs.push(...parseRssItems(uuRss, {
      org: 'Uppsala University', country: 'sweden', location: 'Uppsala',
      baseUrl: 'https://uu.varbi.com/en/',
    }));
  }

  // Strategy B: HTML listing page — confirmed working at /en/
  const uuListUrl = 'https://uu.varbi.com/en/';
  const uuHtml = await safeFetch(uuListUrl, { referer: 'https://uu.varbi.com/' });
  if (uuHtml) {
    const $ = cheerio.load(uuHtml);
    $('article, li, h2, h3, [class*="position"], [class*="vacancy"], [class*="job"]').each((_, el) => {
      const title = $(el).find('a, h2, h3, .title').first().text().trim()
        || $(el).text().trim();
      const link = $(el).find('a').first().attr('href')
        || (el.tagName === 'a' ? $(el).attr('href') : '') || '';
      if (title && title.length > 8 && link.includes('/what:job/')) {
        jobs.push({
          title, org: 'Uppsala University', country: 'sweden', location: 'Uppsala',
          url: link.startsWith('http') ? link : `https://uu.varbi.com${link}`,
        });
      }
    });
    jobs.push(...extractEmbeddedJobs(uuHtml, {
      org: 'Uppsala University', country: 'sweden', location: 'Uppsala', baseUrl: uuListUrl,
    }));
  }

  // Strategy C: Playwright on listing page (renders JS-loaded job list)
  jobs.push(...await parseProtectedPage(uuListUrl,
    { org: 'Uppsala University', country: 'sweden', location: 'Uppsala', baseUrl: uuListUrl },
    {
      ...jsPortalSelectors,
      card: 'article, li, [class*="position"], [class*="vacancy"], [class*="job"], h2, h3',
      title: 'h2, h3, a[href*="/what:job/"], a, .title',
      link: 'a[href*="/what:job/"], a[href]',
    },
    { referer: 'https://uu.varbi.com/', waitForSelector: 'a[href*="/what:job/"], article, li' }
  ));

  // Karolinska Institutet — vacancies page
  const kiUrl = 'https://ki.se/en/vacancies?query=stem+cell+immunology+molecular+biology';
  const kiHtml = await safeFetch(kiUrl);
  if (kiHtml) {
    const $ = cheerio.load(kiHtml);
    $('article, .vacancy, .job, li[class*="result"]').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Karolinska Institutet', country: 'sweden', location: 'Stockholm', url: link.startsWith('http') ? link : `https://ki.se${link}` });
    });
  }
  if (jobs.length < 3) jobs.push(...await parseProtectedPage(kiUrl, { org: 'Karolinska Institutet', country: 'sweden', location: 'Stockholm', baseUrl: kiUrl }, jsPortalSelectors, { waitForSelector: 'article, a[href*="vacanc"], a[href*="job"]' }));

  // SciLifeLab — careers
  const sllHtml = await safeFetch('https://www.scilifelab.se/careers/');
  if (sllHtml) {
    const $ = cheerio.load(sllHtml);
    $('article, .position, li, .job-listing').each((_, el) => {
      const title = $(el).find('h2, h3, a, .entry-title').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title && title.length > 8) jobs.push({ title, org: 'SciLifeLab', country: 'sweden', location: 'Stockholm/Uppsala', url: link.startsWith('http') ? link : `https://www.scilifelab.se${link}` });
    });
  }

  // Lund University — Varbi (same fix as Uppsala)
  // CONFIRMED URLs: listing at https://lu.varbi.com/en/  RSS at https://lu.varbi.com/what:rssfeed/
  const luListUrl = 'https://lu.varbi.com/en/';
  const luRss = await safeFetch('https://lu.varbi.com/what:rssfeed/', {
    headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.7' },
    referer: 'https://lu.varbi.com/en/',
  });
  if (luRss) {
    jobs.push(...parseRssItems(luRss, {
      org: 'Lund University', country: 'sweden', location: 'Lund',
      baseUrl: 'https://lu.varbi.com/en/',
    }));
  }

  const luHtml = await safeFetch(luListUrl, { referer: 'https://lu.varbi.com/' });
  if (luHtml) {
    const $ = cheerio.load(luHtml);
    $('article, li, h2, h3, [class*="position"], [class*="vacancy"]').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link = $(el).find('a').first().attr('href') || '';
      if (title && title.length > 8 && link.includes('/what:job/')) {
        jobs.push({ title, org: 'Lund University', country: 'sweden', location: 'Lund',
          url: link.startsWith('http') ? link : `https://lu.varbi.com${link}` });
      }
    });
    jobs.push(...extractEmbeddedJobs(luHtml, { org: 'Lund University', country: 'sweden', location: 'Lund', baseUrl: luListUrl }));
  }
  jobs.push(...await parseProtectedPage(luListUrl,
    { org: 'Lund University', country: 'sweden', location: 'Lund', baseUrl: luListUrl },
    { ...jsPortalSelectors, title: 'h2, h3, a[href*="/what:job/"], a', link: 'a[href*="/what:job/"], a[href]' },
    { referer: 'https://lu.varbi.com/', waitForSelector: 'a[href*="/what:job/"], article, li' }
  ));

  // Stockholm University — jobs
  const suUrl = 'https://www.su.se/english/about-the-university/work-at-su/available-jobs?query=molecular+immunology+cell+biology';
  const suHtml = await safeFetch(suUrl);
  if (suHtml) {
    const $ = cheerio.load(suHtml);
    $('article, .job, li[class*="result"]').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Stockholm University', country: 'sweden', location: 'Stockholm', url: link.startsWith('http') ? link : `https://www.su.se${link}` });
    });
  }
  if (jobs.length < 6) jobs.push(...await parseProtectedPage(suUrl, { org: 'Stockholm University', country: 'sweden', location: 'Stockholm', baseUrl: suUrl }, jsPortalSelectors, { waitForSelector: 'article, a[href*="job"], a[href*="vacanc"]' }));

  // Chalmers — jobs
  const chalmersUrl = 'https://www.chalmers.se/en/about-chalmers/working-at-chalmers/vacancies/?query=cell+biology+molecular';
  const chalmersHtml = await safeFetch(chalmersUrl);
  if (chalmersHtml) {
    const $ = cheerio.load(chalmersHtml);
    $('article, .vacancy, li[class*="job"]').each((_, el) => {
      const title = $(el).find('h2, h3, a').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Chalmers University', country: 'sweden', location: 'Gothenburg', url: link.startsWith('http') ? link : `https://www.chalmers.se${link}` });
    });
  }
  if (jobs.length < 7) jobs.push(...await parseProtectedPage(chalmersUrl, { org: 'Chalmers University', country: 'sweden', location: 'Gothenburg', baseUrl: chalmersUrl }, jsPortalSelectors, { waitForSelector: 'article, a[href*="vacanc"], a[href*="job"]' }));

  const out = deduplicateRawJobs(jobs);
  console.log(`  Swedish Universities: ${out.length} raw candidates`);
  return out;
}

// ── 7. UNIVERSITY PORTALS — NETHERLANDS ──────────────────────────────────────
async function scrapeDutchUniversities() {
  const jobs = [];

  const sources = [
    { name: 'Leiden University',            country: 'netherlands', location: 'Leiden',      url: 'https://www.universiteitleiden.nl/en/vacancies?query=immunology+stem+cell+molecular' },
    { name: 'University of Amsterdam',      country: 'netherlands', location: 'Amsterdam',   url: 'https://www.uva.nl/en/working-at-the-uva/job-openings/job-openings.html?q=stem+cell+immunology' },
    { name: 'VU Amsterdam',                 country: 'netherlands', location: 'Amsterdam',   url: 'https://workingat.vu.nl/vacancies?query=immunology+molecular+biology' },
    { name: 'Utrecht University',           country: 'netherlands', location: 'Utrecht',     url: 'https://www.uu.nl/en/organisation/working-at-utrecht-university/jobs?q=stem+cell+cell+biology' },
    { name: 'Erasmus MC',                   country: 'netherlands', location: 'Rotterdam',   url: 'https://www.erasmusmc.nl/en/research/vacancies?q=immunology+molecular' },
    { name: 'Wageningen University',        country: 'netherlands', location: 'Wageningen',  url: 'https://www.wur.nl/en/jobs.htm?query=molecular+biology+cell+biology' },
  ];

  for (const src of sources) {
    const defaults = { org: src.name, country: src.country, location: src.location, baseUrl: src.url };
    const pageJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, .vacancy, .job-item, li[class*="job"], li[class*="vacancy"], .result-item, [class*="position"]',
      title: 'h2, h3, a, .title, [class*="title"]',
      link: 'a[href]',
      description: 'p, [class*="summary"], [class*="description"]',
    }, {
      waitForSelector: 'article, a[href*="vacanc"], a[href*="job"], li',
    });
    jobs.push(...pageJobs);
  }
  const out = deduplicateRawJobs(jobs);
  console.log(`  Dutch Universities: ${out.length} raw candidates`);
  return out;
}

// ── 8. UNIVERSITY PORTALS — DENMARK ─────────────────────────────────────────
async function scrapeDanishInstitutions() {
  const jobs = [];

  const sources = [
    { name: 'University of Copenhagen', country: 'denmark', location: 'Copenhagen', url: 'https://employment.ku.dk/phd/?q=stem+cell+immunology+molecular' },
    { name: 'University of Copenhagen (DanStem)', country: 'denmark', location: 'Copenhagen', url: 'https://danstem.ku.dk/join-us/jobs_and_vacancies/' },
    { name: 'DTU',                      country: 'denmark', location: 'Lyngby',     url: 'https://www.dtu.dk/english/about/job-and-career/vacant-positions?q=molecular+biology+cell' },
    { name: 'Aarhus University',        country: 'denmark', location: 'Aarhus',     url: 'https://phd.au.dk/admission/vacancies?q=immunology+stem+cell' },
  ];

  for (const src of sources) {
    const defaults = { org: src.name, country: src.country, location: src.location, baseUrl: src.url };
    const pageJobs = await parseProtectedPage(src.url, defaults, {
      card: 'article, .vacancy, .job, li[class*="job"], .position-item, h2 a, h3 a, [class*="position"]',
      title: 'h2, h3, a, .title, [class*="title"]',
      link: 'a[href]',
      description: 'p, [class*="summary"], [class*="description"]',
    }, {
      waitForSelector: 'article, a[href*="vacanc"], a[href*="job"], h2 a, h3 a, li',
    });
    jobs.push(...pageJobs);
  }
  const out = deduplicateRawJobs(jobs);
  console.log(`  Danish Institutions: ${out.length} raw candidates`);
  return out;
}


// ── 9. EMBL — Workday API + Playwright fallback ───────────────────────────────
// NOTE: Workday CXS API returns 400 without exact headers.
// Fix: send correct Content-Type, X-Workday-Client header, and exact payload shape.
// Always also try Playwright on the public page — it reliably renders all jobs.
async function scrapeEMBL() {
  const jobs = [];
  const workdayApiUrl = 'https://embl.wd103.myworkdayjobs.com/wday/cxs/embl/EMBL/jobs';
  const workdayPageUrl = 'https://embl.wd103.myworkdayjobs.com/EMBL';

  const workdayHeaders = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json',
    'X-Workday-Client': '2024.35.8',
    'Origin': 'https://embl.wd103.myworkdayjobs.com',
    'Referer': workdayPageUrl,
  };

  const searches = ['', 'phd', 'molecular biology', 'cell biology', 'epigenetics', 'immunology'];
  for (const searchText of searches) {
    try {
      const res = await axios.post(workdayApiUrl,
        { appliedFacets: {}, limit: 50, offset: 0, searchText },
        { timeout: REQUEST_TIMEOUT, headers: { ...HEADERS, ...workdayHeaders }, validateStatus: s => s < 400 }
      );
      const data = res.data;
      const defaults = { org: 'EMBL', country: 'germany', location: 'Heidelberg', baseUrl: workdayPageUrl };
      for (const j of data.jobPostings || data.jobs || []) {
        const location = jsonValue(j.locationsText || j.location || j.locations) || defaults.location;
        pushJob(jobs, {
          title: j.title || '',
          org: 'EMBL', location,
          country: resolveCountry(location) || 'germany',
          description: j.bulletFields?.join(' ') || j.summary || '',
          url: j.externalPath ? `${workdayPageUrl}/job${j.externalPath}` : workdayPageUrl,
          deadline: j.postedOn ? `📅 ${j.postedOn}` : undefined,
        }, defaults);
      }
      jobs.push(...extractJobsFromJson(data, defaults));
    } catch (e) {
      console.warn(`  ⚠ EMBL Workday API [${searchText||'all'}]: ${e.response?.status || e.message}`);
    }
  }

  // Playwright on Workday public page — always run, most reliable
  jobs.push(...await parseProtectedPage(workdayPageUrl, {
    org: 'EMBL', country: 'germany', location: 'Heidelberg', baseUrl: workdayPageUrl,
  }, {
    card: '[data-automation-id*="job"], li[class*="css"], article',
    title: '[data-automation-id="jobTitle"], h2, h3, a',
    link: 'a[href*="/job/"], a[href]',
    location: '[data-automation-id*="location"], [class*="location"]',
    description: '[data-automation-id*="description"], p',
  }, {
    referer: 'https://www.embl.org/careers/',
    waitForSelector: '[data-automation-id="jobTitle"], a[href*="/job/"], ul',
    minRenderedFallback: 1,
  }));

  // EMBL public career pages
  for (const { url, type } of [
    { url: 'https://www.embl.org/careers/',        type: undefined },
    { url: 'https://www.embl.org/about/info/embl-international-phd-programme/', type: 'phd' },
  ]) {
    const defaults = { org: 'EMBL', country: 'germany', location: 'Heidelberg', baseUrl: url, type };
    jobs.push(...await parseProtectedPage(url, defaults, {
      card: 'article, .card, .vacancy, li',
      link: 'a[href*="wd103.myworkdayjobs.com"], a[href*="/jobs/"], a[href]',
      title: 'h2, h3, a',
    }, { referer: 'https://www.embl.org/', waitForSelector: 'article, main' }));
  }

  const out = deduplicateRawJobs(jobs).slice(0, MAX_JOBS_PER_SOURCE * 2);
  console.log(`  EMBL: ${out.length} raw candidates`);
  return out;
}


// ── 9. GERMANY / BELGIUM / SWITZERLAND / LUXEMBOURG ──────────────────────────
// NOTE: Several URLs returned 404/403 in last run:
//   - embl.org/jobs/eipp/ → 404 (page moved; use /careers/ instead, handled in scrapeEMBL)
//   - mpg.de scientific-jobs → 404 (URL structure changed)
//   - kuleuven.be vacatures → 403
//   - eth.ch → wrong domain (correct is ethz.ch)
//   - lih.lu/careers/vacancies/ → 404
// All fixed below with correct URLs + Playwright fallback for each.
async function scrapeRestOfEurope() {
  const jobs = [];

  const sources = [
    // Germany
    {
      name: 'Max Planck Society', country: 'germany', location: 'Germany',
      // Corrected URL — MPG uses /jobboard/ not /career/scientific-jobs
      url: 'https://www.mpg.de/jobboard?search=stem+cell+immunology+molecular+biology',
      fallbackUrl: 'https://www.mpg.de/jobboard',
    },
    {
      name: 'Helmholtz Association', country: 'germany', location: 'Germany',
      url: 'https://www.helmholtz.de/en/career/job-vacancies/?tx_solr%5Bq%5D=immunology+molecular+biology',
      fallbackUrl: 'https://www.helmholtz.de/en/career/job-vacancies/',
    },
    {
      name: 'DKFZ', country: 'germany', location: 'Heidelberg',
      url: 'https://www.dkfz.de/en/karriere/stellenangebote.html',
      fallbackUrl: null,
    },
    // Belgium
    {
      name: 'VIB', country: 'belgium', location: 'Ghent',
      url: 'https://vib.be/careers?filter=PhD',
      fallbackUrl: 'https://vib.be/careers',
    },
    {
      name: 'KU Leuven', country: 'belgium', location: 'Leuven',
      // Corrected URL — KU Leuven uses different job portal path
      url: 'https://www.kuleuven.be/personeel/jobsite/en/jobs?q=immunology+molecular+biology',
      fallbackUrl: 'https://www.kuleuven.be/personeel/jobsite/en/jobs',
    },
    {
      name: 'Université Libre de Bruxelles', country: 'belgium', location: 'Brussels',
      url: 'https://www.ulb.be/en/jobs-ulb/research-positions',
      fallbackUrl: null,
    },
    // Switzerland
    {
      name: 'ETH Zurich', country: 'switzerland', location: 'Zurich',
      // Corrected domain: eth.ch → ethz.ch
      url: 'https://jobs.ethz.ch/page/en/open-positions?text=molecular+biology+cell+immunology',
      fallbackUrl: 'https://jobs.ethz.ch/page/en/open-positions',
    },
    {
      name: 'University of Basel', country: 'switzerland', location: 'Basel',
      url: 'https://jobs.unibas.ch/en/vacancies/?q=immunology+stem+cell+molecular',
      fallbackUrl: 'https://jobs.unibas.ch/en/vacancies/',
    },
    {
      name: 'University of Bern', country: 'switzerland', location: 'Bern',
      url: 'https://www.unibe.ch/university/jobs_and_vacancies/index_eng.html',
      fallbackUrl: null,
    },
    // Luxembourg
    {
      name: 'University of Luxembourg', country: 'luxembourg', location: 'Luxembourg',
      url: 'https://jobs.uni.lu/jobPosting/search?q=molecular+biology+immunology',
      fallbackUrl: 'https://jobs.uni.lu/jobPosting/search',
    },
    {
      name: 'Luxembourg Institute of Health', country: 'luxembourg', location: 'Luxembourg',
      // Corrected URL — LIH uses /en/join-us/ not /en/careers/vacancies/
      url: 'https://www.lih.lu/en/join-us/',
      fallbackUrl: 'https://www.lih.lu/en/',
    },
    {
      name: 'LIST Luxembourg', country: 'luxembourg', location: 'Luxembourg',
      url: 'https://www.list.lu/en/list/careers/open-positions/',
      fallbackUrl: null,
    },
  ];

  const selectors = {
    card: 'article, .vacancy, .job, .position, li[class*="job"], li[class*="vacancy"], .result, [class*="JobCard"], tr[class*="job"]',
    title: 'h2, h3, a, .title, [class*="title"], td a',
    link: 'a[href]',
    description: 'p, [class*="summary"], [class*="description"], [class*="excerpt"]',
    location: '[class*="location"], [class*="city"], [class*="place"]',
  };

  for (const src of sources) {
    const defaults = { org: src.name, country: src.country, location: src.location, baseUrl: src.url };

    // Try primary URL first
    let html = await safeFetch(src.url, { referer: `https://${new URL(src.url).hostname}/` });

    // Fallback URL if primary fails
    if (!html && src.fallbackUrl) {
      html = await safeFetch(src.fallbackUrl, { referer: `https://${new URL(src.fallbackUrl).hostname}/` });
      if (html) defaults.baseUrl = src.fallbackUrl;
    }

    if (html) {
      const $ = cheerio.load(html);
      // Broad extraction — any heading/link in a job-like container
      $('article, .vacancy, .job, .position, li[class*="job"], li[class*="vacanc"], .result, tr').each((_, el) => {
        const title = $(el).find('h2, h3, a, .title, td a').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || '';
        if (title && title.length > 8) {
          jobs.push({
            title, org: src.name, country: src.country, location: src.location,
            url: link.startsWith('http') ? link : `${new URL(defaults.baseUrl).origin}${link}`,
          });
        }
      });
      // Also try embedded JSON
      jobs.push(...extractEmbeddedJobs(html, defaults));
    }

    // Playwright fallback for each source — catches JS-rendered pages
    if (!html || jobs.filter(j => j.org === src.name).length === 0) {
      const pwUrl = html ? null : (src.fallbackUrl || src.url);
      if (pwUrl || !html) {
        jobs.push(...await parseProtectedPage(pwUrl || src.url, defaults, selectors, {
          waitForSelector: 'article, a[href*="vacanc"], a[href*="job"], li, tr',
        }));
      }
    }
  }

  const out = deduplicateRawJobs(jobs);
  console.log(`  Rest of Europe (DE/BE/CH/LU): ${out.length} raw candidates`);
  return out;
}

// ── 10. NOVO NORDISK — official search + indexed job ads ────────────────────
async function scrapeNovoNordisk() {
  const jobs = [];
  const queries = [
    'scientist immunology cell biology',
    'molecular biology',
    'cell culture',
    'stem cell',
    'phd',
  ];
  const searchUrls = queries.map(q =>
    `https://www.novonordisk.com/careers/find-a-job.html?searchText=${encodeURIComponent(q)}&country=Denmark`
  );
  searchUrls.push(
    'https://www.novonordisk.com/careers/find-a-job.html',
    'https://www.novonordisk.com/careers/job-listings.html'
  );

  for (const url of searchUrls) {
    const html = await safeFetch(url, { referer: 'https://www.novonordisk.com/careers/' });
    if (!html) continue;
    const defaults = { org: 'Novo Nordisk', country: 'denmark', location: 'Denmark', baseUrl: url };
    jobs.push(...extractEmbeddedJobs(html, defaults));
    jobs.push(...parseHtmlCards(html, defaults, {
      card: 'article, li, .job-card, .result, [class*="job"]',
      link: 'a[href*="/careers/find-a-job/job-ad."], a[href*="job-ad."], a[href]',
      org: '[class*="company"], [class*="department"]',
      location: '[class*="location"], [class*="country"], [class*="city"]',
    }));
  }

  const indexedAds = [
    'https://www.novonordisk.com/careers/find-a-job/job-ad.html',
  ];
  for (const url of indexedAds) {
    const html = await safeFetch(url, { referer: 'https://www.novonordisk.com/careers/find-a-job.html' });
    if (!html) continue;
    jobs.push(...extractEmbeddedJobs(html, { org: 'Novo Nordisk', country: 'denmark', location: 'Denmark', baseUrl: url }));
  }

  const out = deduplicateRawJobs(jobs).slice(0, MAX_JOBS_PER_SOURCE * 2);
  console.log(`  Novo Nordisk: ${out.length} raw candidates`);
  return out;
}

// ── 10. INDUSTRY CAREERS PORTALS ─────────────────────────────────────────────
async function scrapeIndustryCareers() {
  const jobs = [];

  // AstraZeneca — Sweden / Europe jobs
  const azHtml = await safeFetch('https://careers.astrazeneca.com/search-jobs?location=Sweden&keywords=research+scientist+cell+biology+immunology');
  if (azHtml) {
    const $ = cheerio.load(azHtml);
    $('li[class*="job"], .job-result, article').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'AstraZeneca', country: 'sweden', location: 'Gothenburg', url: link.startsWith('http') ? link : `https://careers.astrazeneca.com${link}` });
    });
  }

  // Novo Nordisk — graduate & scientist roles
  const novoHtml = await safeFetch('https://www.novonordisk.com/careers/job-listings.html#countryCode=DK&keywords=scientist%20immunology%20cell%20biology');
  if (novoHtml) {
    const $ = cheerio.load(novoHtml);
    $('li[class*="job"], .job-card, article').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Novo Nordisk', country: 'denmark', location: 'Bagsværd', url: link.startsWith('http') ? link : `https://www.novonordisk.com${link}` });
    });
  }

  // Roche
  const rocheHtml = await safeFetch('https://careers.roche.com/global/en/search-results?keywords=cell+culture+scientist&location=Basel&country=Switzerland');
  if (rocheHtml) {
    const $ = cheerio.load(rocheHtml);
    $('li[class*="job"], .job-result, .card').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Roche', country: 'switzerland', location: 'Basel', url: link.startsWith('http') ? link : `https://careers.roche.com${link}` });
    });
  }

  // Novartis
  const novartisHtml = await safeFetch('https://careers.novartis.com/search?keywords=scientist+cell+biology+immunology&location=Switzerland');
  if (novartisHtml) {
    const $ = cheerio.load(novartisHtml);
    $('li[class*="job"], .job-result').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Novartis', country: 'switzerland', location: 'Basel', url: link.startsWith('http') ? link : `https://careers.novartis.com${link}` });
    });
  }

  // Bayer
  const bayerHtml = await safeFetch('https://career.bayer.de/en/jobs?keywords=molecular+biology+toxicology+cell+culture&location=Germany');
  if (bayerHtml) {
    const $ = cheerio.load(bayerHtml);
    $('li[class*="job"], article, .job-listing').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Bayer AG', country: 'germany', location: 'Berlin/Wuppertal', url: link.startsWith('http') ? link : `https://career.bayer.de${link}` });
    });
  }

  // Thermo Fisher Scientific — Sweden
  const tfsHtml = await safeFetch('https://jobs.thermofisher.com/global/en/sweden-jobs?keywords=scientist+cell+culture+qpcr+molecular');
  if (tfsHtml) {
    const $ = cheerio.load(tfsHtml);
    $('li[class*="job"], .job-result').each((_, el) => {
      const title = $(el).find('a, h2, h3').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Thermo Fisher Scientific', country: 'sweden', location: 'Stockholm', url: link.startsWith('http') ? link : `https://jobs.thermofisher.com${link}` });
    });
  }

  console.log(`  Industry Careers: ${jobs.length} raw candidates`);
  return jobs;
}

// ─── DEDUPLICATION ───────────────────────────────────────────────────────────

function deduplicateJobs(jobsArr) {
  const seen = new Map();
  const out  = [];
  for (const j of jobsArr) {
    const fp = j._fp || fingerprint(j.title, j.org);
    if (!seen.has(fp)) {
      seen.set(fp, true);
      out.push(j);
    }
  }
  return out;
}

// ─── FALLBACK CURATED JOBS ───────────────────────────────────────────────────
// Used ONLY when all live scraping returns 0 scored jobs.
// These are clearly marked source:'fallback' so the frontend never counts them as new.

const FALLBACK_JOBS = [
  { id:'fb-ki-stem',      country:'sweden',      tier:'high',   type:'phd',      org:'Karolinska Institutet',      score:88, title:'PhD — Stem Cell Biology & Epigenetics',               tags:['🎓 PhD','📍 Stockholm','Fully Funded','⚠️ Fallback'],  why:'ESC culture, DNA methylation, immunology. Direct match to your thesis background.',              deadline:'📅 Rolling',       deadlineWarn:false, url:'https://education.ki.se/doctoral-education',                          source:'fallback' },
  { id:'fb-leiden',       country:'netherlands', tier:'high',   type:'phd',      org:'Leiden University',           score:86, title:'PhD — Molecular Immunology & Cell Therapy',          tags:['🎓 PhD','📍 Leiden','EU Funded','⚠️ Fallback'],        why:'T-cell immunology, cell differentiation, fully funded EU program.',                              deadline:'📅 Check site',    deadlineWarn:false, url:'https://www.universiteitleiden.nl/en/vacancies',                       source:'fallback' },
  { id:'fb-danstem',      country:'denmark',     tier:'high',   type:'phd',      org:'University of Copenhagen',    score:89, title:'PhD — Pluripotency & Epigenomics (DanStem)',         tags:['🎓 PhD','📍 Copenhagen','Fully Funded','⚠️ Fallback'],  why:'ESC pluripotency, epigenetic markers, stem cell biology centre.',                                deadline:'📅 Check site',    deadlineWarn:false, url:'https://danstem.ku.dk/join-us/jobs_and_vacancies/',                    source:'fallback' },
  { id:'fb-embl',         country:'germany',     tier:'high',   type:'phd',      org:'EMBL Heidelberg',             score:87, title:'PhD — Molecular Systems Biology & Epigenomics',      tags:['🎓 PhD','📍 Heidelberg','Fully Funded','⚠️ Fallback'],  why:'World-class epigenomics research. NGS, molecular biology, stem cells.',                          deadline:'📅 Rolling',       deadlineWarn:false, url:'https://www.embl.org/jobs/eipp/',                                     source:'fallback' },
  { id:'fb-lund-ramp',    country:'sweden',      tier:'high',   type:'phd',      org:'Lund Stem Cell Center',       score:85, title:'PhD — RAMP-UP Programme (Regenerative Medicine)',    tags:['🎓 PhD','📍 Lund','21 Funded Spots','⚠️ Fallback'],    why:'ESC culture, cell differentiation, GLP, ATMP. Up to 21 fully funded positions.',                deadline:'📅 Rolling',       deadlineWarn:false, url:'https://www.stemcellcenter.lu.se/open-positions',                     source:'fallback' },
  { id:'fb-az',           country:'sweden',      tier:'high',   type:'industry', org:'AstraZeneca R&D',             score:82, title:'Research Scientist — Cell Therapy Development',      tags:['🏢 Industry','📍 Gothenburg','MSc Level','⚠️ Fallback'], why:'ESC culture, cell differentiation, GLP compliance, ATMP experience valued.',                    deadline:'📅 Rolling',       deadlineWarn:false, url:'https://careers.astrazeneca.com/search-jobs',                        source:'fallback' },
  { id:'fb-tfs',          country:'sweden',      tier:'high',   type:'industry', org:'Thermo Fisher Scientific',   score:80, title:'Associate Scientist — Cell Culture & QC',            tags:['🏢 Industry','📍 Stockholm','MSc Level','⚠️ Fallback'], why:'qPCR, ELISA, cell assays, GLP compliance — directly in your toolkit.',                          deadline:'📅 Rolling',       deadlineWarn:false, url:'https://jobs.thermofisher.com/global/en/sweden-jobs',                source:'fallback' },
  { id:'fb-scilifelab',   country:'sweden',      tier:'high',   type:'industry', org:'SciLifeLab / KTH',            score:78, title:'Research Engineer — Molecular Biology & RNA Handling', tags:['🏢 Industry','📍 Stockholm','Research Eng.','⚠️ Fallback'], why:'RNA prep, qPCR, NGS library prep, cell assays. SciLifeLab affiliated.',                      deadline:'📅 Continuous',    deadlineWarn:false, url:'https://www.scilifelab.se/careers/',                                   source:'fallback' },
  { id:'fb-novo',         country:'denmark',     tier:'medium', type:'industry', org:'Novo Nordisk',                score:76, title:'Lab Scientist — Immunology Assay Development',       tags:['🏢 Industry','📍 Bagsværd','MSc Level','⚠️ Fallback'],  why:'qPCR, immunofluorescence, ELISA, immunology specialisation required.',                           deadline:'📅 Rolling',       deadlineWarn:false, url:'https://www.novonordisk.com/careers/early-talent',                    source:'fallback' },
  { id:'fb-vib',          country:'belgium',     tier:'high',   type:'phd',      org:'VIB Ghent',                   score:84, title:'PhD — Mucosal Immunology & Barrier Function',        tags:['🎓 PhD','📍 Ghent','Fully Funded','⚠️ Fallback'],       why:'Caco-2 cell culture, mucosal immunology, barrier function. Directly matches your skills.',      deadline:'📅 Rolling',       deadlineWarn:false, url:'https://vib.be/careers',                                              source:'fallback' },
  { id:'fb-roche',        country:'switzerland', tier:'medium', type:'industry', org:'Roche Diagnostics',           score:75, title:'Bioprocess Specialist — Cell Culture Systems',       tags:['🏢 Industry','📍 Basel','MSc Level','⚠️ Fallback'],     why:'Cell culture optimisation, qPCR, GLP batch testing.',                                            deadline:'📅 Rolling',       deadlineWarn:false, url:'https://careers.roche.com',                                           source:'fallback' },
];

function readHistoricalJobs() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs
      .filter(j => j && j.title && j.org && j.url)
      .slice(0, 60);
  } catch (e) {
    console.warn(`  ⚠ Could not read historical jobs cache: ${e.message}`);
    return [];
  }
}

function writeHistoricalJobs(liveJobs) {
  if (!liveJobs.length) return;
  try {
    const existing = readHistoricalJobs();
    const merged = deduplicateJobs([
      ...liveJobs.map(j => ({ ...j, cachedAt: new Date().toISOString() })),
      ...existing,
    ])
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 60);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({
      updatedAt: new Date().toISOString(),
      jobs: merged,
    }, null, 2));
    console.log(`💾 Historical live cache updated: ${merged.length} jobs`);
  } catch (e) {
    console.warn(`  ⚠ Could not write historical jobs cache: ${e.message}`);
  }
}

function historicalFallbackJobs(liveJobs = []) {
  const liveFingerprints = new Set(liveJobs.map(j => fingerprint(j.title, j.org)));
  return readHistoricalJobs()
    .filter(j => !liveFingerprints.has(fingerprint(j.title, j.org)))
    .map(j => ({
      ...j,
      id: `hist-${fingerprint(j.title, j.org).replace(/[^a-z0-9]/g, '-').substring(0, 48)}`,
      source: 'fallback',
      fetchedAt: new Date().toISOString(),
      // Preserve original dateFound — don't overwrite with today's date
      dateFound: j.dateFound || j.cachedAt || new Date().toISOString(),
      tags: [...(j.tags || []).filter(t => !String(t).includes('Fallback')), 'Recent live'],
      why: `Preserved from a previous successful live scrape. ${j.why || ''}`.trim().substring(0, 180),
      _fp: fingerprint(j.title, j.org),
    }))
    .slice(0, TARGET_LIVE_JOBS * 2);
}

function fallbackPool(liveJobs = []) {
  const liveFingerprints = new Set(liveJobs.map(j => fingerprint(j.title, j.org)));
  const historical = historicalFallbackJobs(liveJobs);
  const historicalFingerprints = new Set(historical.map(j => fingerprint(j.title, j.org)));
  const staticFallback = FALLBACK_JOBS
    .filter(j => !liveFingerprints.has(fingerprint(j.title, j.org)))
    .filter(j => !historicalFingerprints.has(fingerprint(j.title, j.org)));
  return [...historical, ...staticFallback];
}

// ─── MAIN ORCHESTRATOR ───────────────────────────────────────────────────────

async function scrapeAllSources() {
  console.log('\n📡 Starting multi-source live scrape...\n');

  // Run all scrapers in parallel — failure of any one never breaks the rest
  const [
    euraxessRaw,
    academicPosRaw,
    academicTransferRaw,
    natureCareersRaw,
    findaPhdRaw,
    swedishRaw,
    dutchRaw,
    danishRaw,
    emblRaw,
    restEuropeRaw,
    novoRaw,
    industryRaw,
  ] = await Promise.allSettled([
    scrapeEuraxess(),
    scrapeAcademicPositions(),
    scrapeAcademicTransfer(),
    scrapeNatureCareers(),
    scrapeFindAPhD(),
    scrapeSwedishUniversities(),
    scrapeDutchUniversities(),
    scrapeDanishInstitutions(),
    scrapeEMBL(),
    scrapeRestOfEurope(),
    scrapeNovoNordisk(),
    scrapeIndustryCareers(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  // Tag each raw job with its source name and type so the scorer can apply
  // the right threshold. 'portal' = general university vacancy pages (noisier).
  // 'keyword' = search-result pages that pre-filter by relevant terms (cleaner).
  function tagSource(arr, source, sourceType = 'keyword') {
    return arr.map(j => ({ ...j, _source: source, _sourceType: sourceType }));
  }

  const allRaw = [
    ...tagSource(euraxessRaw,       'euraxess',        'keyword'),
    ...tagSource(academicPosRaw,    'academicpos',     'keyword'),
    ...tagSource(academicTransferRaw,'academictransfer','portal'),  // general NL portal
    ...tagSource(natureCareersRaw,  'nature',          'keyword'),
    ...tagSource(findaPhdRaw,       'findaphd',        'keyword'),
    ...tagSource(swedishRaw,        'swedish',         'portal'),   // general SE portals
    ...tagSource(dutchRaw,          'dutch',           'portal'),   // general NL portals
    ...tagSource(danishRaw,         'danish',          'portal'),   // general DK portals
    ...tagSource(emblRaw,           'embl',            'keyword'),
    ...tagSource(restEuropeRaw,     'resteurope',      'portal'),   // general EU portals
    ...tagSource(novoRaw,           'novo',            'keyword'),
    ...tagSource(industryRaw,       'industry',        'keyword'),
  ];

  await closeBrowser();

  // Log source breakdown so we can spot which sources are contributing
  const sourceBreakdown = {};
  allRaw.forEach(j => {
    sourceBreakdown[j._source] = (sourceBreakdown[j._source] || 0) + 1;
  });
  console.log('\n📦 Raw candidates per source:');
  Object.entries(sourceBreakdown)
    .sort((a, b) => b[1] - a[1])
    .forEach(([src, n]) => {
      const type = GENERAL_PORTAL_SOURCES.has(src) ? '(portal, threshold ≥62)' : '(keyword, threshold ≥48)';
      console.log(`   ${src.padEnd(18)} ${String(n).padStart(4)} ${type}`);
    });
  console.log(`\n📊 Total raw candidates across all sources: ${allRaw.length}`);

  // Score and filter — pass sourceType so portal sources get tighter threshold
  const scored = [];
  for (const raw of allRaw) {
    if (!raw.title || raw.title.length < 6) continue;
    const sourceType = raw._sourceType || 'keyword';
    const job = buildJob(raw, raw._source || 'live', sourceType);
    if (job) scored.push(job);
  }

  console.log(`✅ Passed scoring threshold: ${scored.length} jobs`);

  // Sort by score descending before capping
  scored.sort((a, b) => b.score - a.score);

  // Deduplicate by fingerprint
  const deduped = deduplicateJobs(scored);
  console.log(`🔄 After deduplication: ${deduped.length} unique live jobs`);

  // Fix 6: Adaptive per-org cap.
  // When we have plenty of jobs, cap tightly (3/org) to ensure diversity.
  // When live yield is low (< 20), raise cap to 5 so we don't discard valid jobs
  // from a good source just because it contributed more than 3.
  const effectiveCap = scored.length < 20 ? 5 : MAX_JOBS_PER_ORG;
  const orgCounts = {};
  const capped = deduped.filter(job => {
    const orgKey = (job.org || '').toLowerCase().trim();
    orgCounts[orgKey] = (orgCounts[orgKey] || 0) + 1;
    return orgCounts[orgKey] <= effectiveCap;
  });
  const cappedOut = deduped.length - capped.length;
  if (cappedOut > 0) console.log(`🏛  Per-org cap (${effectiveCap}/org): removed ${cappedOut} lower-scoring duplicates`);

  // Remove internal fingerprint field before posting
  capped.forEach(j => { delete j._fp; delete j._source; delete j._sourceType; });
  writeHistoricalJobs(capped);

  // If we found enough live jobs — return them, no fallback
  if (capped.length >= TARGET_LIVE_JOBS) {
    console.log(`\n🎯 SUCCESS: ${capped.length} live jobs found — skipping fallback\n`);
    return { jobs: capped, usedFallback: false };
  }

  // Partial live results — append only fallbacks that don't duplicate a live job
  if (capped.length > 0) {
    const padFallback = fallbackPool(capped);
    console.log(`⚠️  Only ${capped.length} live jobs found — padding with ${padFallback.length} historical/static fallbacks`);
    return { jobs: [...capped, ...padFallback], usedFallback: true };
  }

  // Zero live jobs — full fallback
  const intelligentFallback = fallbackPool([]);
  console.log(`❌ No live jobs found — using ${intelligentFallback.length} historical/static fallback jobs`);
  return { jobs: intelligentFallback, usedFallback: true };
}

// ─── POST TO API ─────────────────────────────────────────────────────────────

async function postToAPI(jobs, usedFallback) {
  const apiUrl = process.env.API_URL;
  const apiKey = process.env.API_KEY;

  if (!apiUrl || !apiKey) {
    console.error('❌ API_URL or API_KEY not set in environment / GitHub Secrets');
    return false;
  }

  const liveCount     = jobs.filter(j => j.source === 'live').length;
  const fallbackCount = jobs.filter(j => j.source === 'fallback').length;

  console.log(`\n📤 Posting to API: ${liveCount} live + ${fallbackCount} fallback jobs`);

  try {
    const response = await axios.post(`${apiUrl}/api/jobs`, {
      jobs,
      apiKey,
      meta: {
        scrapedAt: new Date().toISOString(),
        liveCount,
        fallbackCount,
        usedFallback,
      }
    }, { timeout: 15000 });

    console.log(`✓ API accepted ${response.data.count ?? jobs.length} jobs`);
    if (response.data.lastUpdated) console.log(`✓ Last updated: ${response.data.lastUpdated}`);
    return true;
  } catch (e) {
    console.error('❌ Failed to post to API:', e.response?.data || e.message);
    return false;
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🔬 KAVYA JOB BOARD — Live Scraper Starting');
  console.log(`   ${new Date().toUTCString()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  const { jobs, usedFallback } = await scrapeAllSources();

  const success = await postToAPI(jobs, usedFallback);

  console.log('\n═══════════════════════════════════════════════════════');
  if (success) {
    const liveCount = jobs.filter(j => j.source === 'live').length;
    console.log(`✅ Complete — ${liveCount} live jobs posted${usedFallback ? ' (fallback padded)' : ''}`);
    process.exit(0);
  } else {
    console.log('⚠️  Scrape ran but API post failed — check logs');
    process.exit(1);
  }
})();

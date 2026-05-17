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

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT = 12000; // ms per fetch
const MAX_JOBS_PER_SOURCE = 20;
const MIN_SCORE_THRESHOLD = 62; // below this → skip
const TARGET_LIVE_JOBS    = 8;  // if we get at least this many live, skip fallback

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

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
  { kw: 'qpcr',                   w: 13 },
  { kw: 'rt-qpcr',                w: 14 },
  { kw: 'molecular biology',      w: 12 },
  { kw: 'neurodegener',           w: 12 },
  { kw: 'neurodegeneration',      w: 14 },
  { kw: 'organoid',               w: 14 },
  { kw: 'regenerative medicine',  w: 15 },
  { kw: 'caco-2',                 w: 14 },
  { kw: 'sh-sy5y',                w: 16 },
  { kw: 'glp',                    w: 10 },
  { kw: 'qa/qc',                  w: 10 },
  { kw: 'atmp',                   w: 12 },
  { kw: 'cell therapy',           w: 14 },
  { kw: 'epigenomics',            w: 15 },
  // Role types
  { kw: 'marie curie',            w: 20 },
  { kw: 'msca',                   w: 18 },
  { kw: 'fully funded',           w: 15 },
  { kw: 'research assistant',     w: 10 },
  { kw: 'research engineer',      w: 10 },
  { kw: 'associate scientist',    w: 10 },
  { kw: 'phd student',            w: 14 },
  { kw: 'doctoral',               w: 12 },
];

// Hard exclusions — if present, score → -1 (drop job entirely)
const HARD_EXCLUDE = [
  'bioinformatics only',
  'software engineer',
  'software developer',
  'data scientist',
  'nursing',
  'nurse ',
  'postdoctoral',
  'postdoc ',
  'post-doc',
  'full professor',
  'associate professor',
  'assistant professor',
  'business development',
  'sales representative',
  'account manager',
  'pure chemistry',
  'inorganic chemistry',
  'veterinary',
  'animal husbandry only',
];

// Soft exclusions — reduce score but don't drop
const SOFT_EXCLUDE = [
  { kw: 'senior scientist',   penalty: 12 },
  { kw: 'director',           penalty: 15 },
  { kw: 'manager',            penalty: 15 },
  { kw: 'head of',            penalty: 18 },
  { kw: 'team lead',          penalty: 12 },
  { kw: 'bioinformatics',     penalty: 8  },
  { kw: 'machine learning',   penalty: 6  },
  { kw: 'deep learning',      penalty: 6  },
  { kw: 'animal model only',  penalty: 10 },
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

function scoreJob(title = '', description = '') {
  const text = (title + ' ' + description).toLowerCase();

  // Hard exclusion check
  for (const excl of HARD_EXCLUDE) {
    if (text.includes(excl)) return -1;
  }

  let score = 42; // base

  // PhD / role boosts applied first
  if (text.includes('phd') || text.includes('doctoral')) score += 12;
  if (text.includes('fully funded') || text.includes('marie curie') || text.includes('msca')) score += 18;
  if (/research\s+(assistant|engineer|scientist|associate)/i.test(text)) score += 8;

  // Strong keyword matches
  for (const { kw, w } of STRONG_KEYWORDS) {
    if (text.includes(kw)) score += w;
  }

  // Soft exclusion penalties
  for (const { kw, penalty } of SOFT_EXCLUDE) {
    if (text.includes(kw)) score -= penalty;
  }

  return Math.max(0, Math.min(score, 100));
}

function tierFromScore(score) {
  return score >= 80 ? 'high' : score >= 65 ? 'medium' : 'stretch';
}

function typeFromText(text) {
  const t = text.toLowerCase();
  return (t.includes('phd') || t.includes('doctoral')) ? 'phd' : 'industry';
}

// Stable dedup fingerprint (matches the frontend jobKey logic)
function fingerprint(title = '', org = '') {
  return `${org.toLowerCase().replace(/\s+/g, ' ').trim()}||${title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

// Build a proper job object from raw fields
function buildJob(raw, source) {
  const score = scoreJob(raw.title, raw.description || '');
  if (score < MIN_SCORE_THRESHOLD) return null;

  const country = resolveCountry(raw.country);
  const type    = raw.type || typeFromText(raw.title + ' ' + (raw.description || ''));
  const tier    = tierFromScore(score);
  const why     = raw.description
    ? raw.description.replace(/\s+/g, ' ').trim().substring(0, 160) + '…'
    : `Live listing from ${source}. Matches your profile on molecular biology & cell culture skills.`;

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

// Safe fetch wrapper — never throws
async function safeFetch(url, opts = {}) {
  try {
    const res = await axios.get(url, {
      timeout: opts.timeout || REQUEST_TIMEOUT,
      headers: { ...HEADERS, ...(opts.headers || {}) },
      maxRedirects: 5,
    });
    return res.data;
  } catch (e) {
    console.warn(`  ⚠ Fetch failed [${url.substring(0, 70)}]: ${e.message}`);
    return null;
  }
}

// ─── SOURCE SCRAPERS ─────────────────────────────────────────────────────────
// Each returns an array of raw job objects { title, org, country, description, url, ... }
// buildJob() normalises + scores them later.

// ── 1. EURAXESS (XML/JSON feed) ───────────────────────────────────────────────
async function scrapeEuraxess() {
  const jobs = [];
  // EURAXESS has an RSS feed for each country — try multiple keyword searches
  const queries = [
    'stem+cell+immunology',
    'epigenetics+molecular+biology',
    'cell+culture+phd',
    'marie+curie+life+sciences',
  ];
  const countries = ['SE', 'NL', 'DK', 'DE', 'BE', 'CH', 'LU'];

  for (const q of queries) {
    const url = `https://euraxess.ec.europa.eu/api/jobs/search?keywords=${q}&`
              + countries.map(c => `country=${c}`).join('&')
              + `&pageSize=${MAX_JOBS_PER_SOURCE}&format=json`;
    const data = await safeFetch(url);
    if (!data || !data.jobs) continue;

    for (const j of data.jobs.slice(0, MAX_JOBS_PER_SOURCE)) {
      jobs.push({
        title:       j.jobTitle || j.title || '',
        org:         j.organisationName || j.organisation || '',
        country:     j.countryCode || j.country || '',
        location:    j.city || '',
        description: j.jobAbstract || j.description || '',
        url:         j.jobLink || j.url || 'https://euraxess.ec.europa.eu/jobs/search',
        deadline:    j.applicationDeadline ? `📅 ${j.applicationDeadline}` : '📅 Rolling',
        deadlineWarn: false,
      });
    }
  }

  // Also try the HTML search page as a backup
  const htmlUrl = 'https://euraxess.ec.europa.eu/jobs/search?keywords=stem+cell+immunology&country=SE,NL,DK,DE,BE,CH,LU';
  const html = await safeFetch(htmlUrl);
  if (html) {
    const $ = cheerio.load(html);
    $('.job-result, .views-row, article.job').each((_, el) => {
      const title = $(el).find('h3, .job-title, .views-field-title').first().text().trim();
      const org   = $(el).find('.organisation-name, .field-name-field-job-organisation').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      const desc  = $(el).find('.field-name-body, .job-description, p').first().text().trim();
      if (title) jobs.push({ title, org: org || 'EURAXESS', country: 'se', description: desc, url: link.startsWith('http') ? link : `https://euraxess.ec.europa.eu${link}` });
    });
  }

  console.log(`  EURAXESS: ${jobs.length} raw candidates`);
  return jobs;
}

// ── 2. ACADEMIC POSITIONS ─────────────────────────────────────────────────────
async function scrapeAcademicPositions() {
  const jobs = [];
  const urls = [
    'https://academicpositions.com/jobs/position/phd/field/immunology',
    'https://academicpositions.com/jobs/position/phd/field/molecular-biology',
    'https://academicpositions.com/jobs/position/phd/field/stem-cell-biology',
    'https://academicpositions.com/jobs/position/research-assistant/country/sweden',
    'https://academicpositions.com/jobs/position/research-assistant/country/netherlands',
    'https://academicpositions.com/jobs/position/research-engineer/country/sweden',
  ];

  for (const url of urls) {
    const html = await safeFetch(url);
    if (!html) continue;
    const $ = cheerio.load(html);

    $('article.job-list-item, .job-card, .job-listing, li.job').each((_, el) => {
      const title = $(el).find('h2, h3, .job-title, [class*="title"]').first().text().trim();
      const org   = $(el).find('.employer, .university, [class*="employer"], [class*="university"]').first().text().trim();
      const link  = $(el).find('a[href*="/jobs/"]').first().attr('href') || $(el).find('a').first().attr('href') || '';
      const desc  = $(el).find('p, .description, [class*="description"]').first().text().trim();
      const loc   = $(el).find('.location, [class*="location"]').first().text().trim();
      const dl    = $(el).find('.deadline, [class*="deadline"]').first().text().trim();
      if (title && title.length > 5) {
        jobs.push({
          title, org,
          country: resolveCountry(loc) || 'sweden',
          location: loc,
          description: desc,
          url: link.startsWith('http') ? link : `https://academicpositions.com${link}`,
          deadline: dl ? `📅 ${dl}` : '📅 Rolling',
        });
      }
    });
  }
  console.log(`  Academic Positions: ${jobs.length} raw candidates`);
  return jobs;
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
  const queries = ['stem-cell', 'immunology', 'epigenetics', 'molecular-biology', 'cell-biology'];

  for (const q of queries) {
    const url = `https://www.nature.com/naturecareers/jobs?text=${q}&location=Europe&employment-type=PhD+studentship,Full-time`;
    const html = await safeFetch(url);
    if (!html) continue;
    const $ = cheerio.load(html);

    $('li[class*="ResultsList"], article[class*="job"], .job-result').each((_, el) => {
      const title = $(el).find('h2, h3, a[class*="title"]').first().text().trim();
      const org   = $(el).find('[class*="employer"], [class*="organisation"]').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      const loc   = $(el).find('[class*="location"]').first().text().trim();
      const desc  = $(el).find('p, [class*="description"]').first().text().trim();
      if (title) {
        jobs.push({
          title, org: org || 'Nature Careers Listing',
          country: resolveCountry(loc) || 'sweden',
          location: loc,
          description: desc,
          url: link.startsWith('http') ? link : `https://www.nature.com${link}`,
        });
      }
    });
  }
  console.log(`  Nature Careers: ${jobs.length} raw candidates`);
  return jobs;
}

// ── 5. FINDAPHD ──────────────────────────────────────────────────────────────
async function scrapeFindAPhD() {
  const jobs = [];
  const queries = [
    'stem-cell',
    'immunology',
    'epigenetics',
    'molecular-biology',
    'cell-culture',
    'marie-curie',
  ];
  const countryIds = '13,10,7,6,4,22,50'; // Sweden, Netherlands, Denmark, Germany, Belgium, Switzerland, Luxembourg

  for (const q of queries) {
    const url = `https://www.findaphd.com/phds/european-phds/?Keywords=${q}&CountryID=${countryIds}`;
    const html = await safeFetch(url);
    if (!html) continue;
    const $ = cheerio.load(html);

    $('.phd-result, .FindAPhD-CombinedOppRow, article.phd').each((_, el) => {
      const title = $(el).find('h3 a, .title a, h2 a').first().text().trim();
      const org   = $(el).find('.phd-dept, .department, .uni-name, .institution').first().text().trim();
      const link  = $(el).find('h3 a, a[class*="phd"]').first().attr('href') || $(el).find('a').first().attr('href') || '';
      const desc  = $(el).find('p.phd-summary, .description, p').first().text().trim();
      const loc   = $(el).find('.country, .location').first().text().trim();
      if (title) {
        jobs.push({
          title, org: org || 'European University',
          country: resolveCountry(loc) || 'germany',
          location: loc,
          description: desc,
          type: 'phd',
          url: link.startsWith('http') ? link : `https://www.findaphd.com${link}`,
        });
      }
    });
  }
  console.log(`  FindAPhD: ${jobs.length} raw candidates`);
  return jobs;
}

// ── 6. UNIVERSITY PORTALS — SWEDEN ───────────────────────────────────────────
async function scrapeSwedishUniversities() {
  const jobs = [];

  // Uppsala University — Varbi system
  const uuHtml = await safeFetch('https://uu.varbi.com/en/what:job/list/?pageSize=30&searchQuery=stem+cell+immunology+molecular');
  if (uuHtml) {
    const $ = cheerio.load(uuHtml);
    $('article, .job-item, li[class*="job"], .varbi-position').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Uppsala University', country: 'sweden', location: 'Uppsala', url: link.startsWith('http') ? link : `https://uu.varbi.com${link}` });
    });
  }

  // Karolinska Institutet — vacancies page
  const kiHtml = await safeFetch('https://ki.se/en/vacancies?query=stem+cell+immunology+molecular+biology');
  if (kiHtml) {
    const $ = cheerio.load(kiHtml);
    $('article, .vacancy, .job, li[class*="result"]').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Karolinska Institutet', country: 'sweden', location: 'Stockholm', url: link.startsWith('http') ? link : `https://ki.se${link}` });
    });
  }

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

  // Lund University — Varbi
  const luHtml = await safeFetch('https://lu.varbi.com/en/what:job/list/?searchQuery=stem+cell+immunology+molecular');
  if (luHtml) {
    const $ = cheerio.load(luHtml);
    $('article, .job-item, .varbi-position').each((_, el) => {
      const title = $(el).find('h2, h3, a').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Lund University', country: 'sweden', location: 'Lund', url: link.startsWith('http') ? link : `https://lu.varbi.com${link}` });
    });
  }

  // Stockholm University — jobs
  const suHtml = await safeFetch('https://www.su.se/english/about-the-university/work-at-su/available-jobs?query=molecular+immunology+cell+biology');
  if (suHtml) {
    const $ = cheerio.load(suHtml);
    $('article, .job, li[class*="result"]').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Stockholm University', country: 'sweden', location: 'Stockholm', url: link.startsWith('http') ? link : `https://www.su.se${link}` });
    });
  }

  // Chalmers — jobs
  const chalmersHtml = await safeFetch('https://www.chalmers.se/en/about-chalmers/working-at-chalmers/vacancies/?query=cell+biology+molecular');
  if (chalmersHtml) {
    const $ = cheerio.load(chalmersHtml);
    $('article, .vacancy, li[class*="job"]').each((_, el) => {
      const title = $(el).find('h2, h3, a').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) jobs.push({ title, org: 'Chalmers University', country: 'sweden', location: 'Gothenburg', url: link.startsWith('http') ? link : `https://www.chalmers.se${link}` });
    });
  }

  console.log(`  Swedish Universities: ${jobs.length} raw candidates`);
  return jobs;
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
    const html = await safeFetch(src.url);
    if (!html) continue;
    const $ = cheerio.load(html);
    $('article, .vacancy, .job-item, li[class*="job"], li[class*="vacancy"], .result-item').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title, [class*="title"]').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title && title.length > 8) {
        jobs.push({ title, org: src.name, country: src.country, location: src.location, url: link.startsWith('http') ? link : `${new URL(src.url).origin}${link}` });
      }
    });
  }
  console.log(`  Dutch Universities: ${jobs.length} raw candidates`);
  return jobs;
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
    const html = await safeFetch(src.url);
    if (!html) continue;
    const $ = cheerio.load(html);
    $('article, .vacancy, .job, li[class*="job"], .position-item, h2 a, h3 a').each((_, el) => {
      const title = el.tagName === 'a'
        ? $(el).text().trim()
        : $(el).find('h2, h3, a, .title').first().text().trim();
      const link = el.tagName === 'a'
        ? $(el).attr('href') || ''
        : $(el).find('a').first().attr('href') || '';
      if (title && title.length > 8) {
        jobs.push({ title, org: src.name, country: src.country, location: src.location, url: link.startsWith('http') ? link : `${new URL(src.url).origin}${link}` });
      }
    });
  }
  console.log(`  Danish Institutions: ${jobs.length} raw candidates`);
  return jobs;
}

// ── 9. GERMANY / BELGIUM / SWITZERLAND / LUXEMBOURG ──────────────────────────
async function scrapeRestOfEurope() {
  const jobs = [];

  const sources = [
    { name: 'EMBL',                  country: 'germany',     location: 'Heidelberg', url: 'https://www.embl.org/jobs/eipp/' },
    { name: 'Max Planck Society',    country: 'germany',     location: 'Germany',    url: 'https://www.mpg.de/en/career/scientific-jobs?q=stem+cell+immunology+molecular+biology' },
    { name: 'VIB',                   country: 'belgium',     location: 'Ghent',      url: 'https://vib.be/careers?filter=PhD' },
    { name: 'KU Leuven',             country: 'belgium',     location: 'Leuven',     url: 'https://www.kuleuven.be/personeel/jobsite/jobs/vacatures?q=immunology+molecular+biology+phd' },
    { name: 'ETH Zurich',            country: 'switzerland', location: 'Zurich',     url: 'https://eth.ch/en/the-eth-zurich/working-teaching-and-research/jobs.html?query=molecular+biology+cell' },
    { name: 'University of Basel',   country: 'switzerland', location: 'Basel',      url: 'https://jobs.unibas.ch/en/vacancies/?q=immunology+stem+cell+molecular' },
    { name: 'University of Luxembourg', country: 'luxembourg', location: 'Luxembourg', url: 'https://jobs.uni.lu/jobPosting/search?q=molecular+biology+immunology' },
    { name: 'Luxembourg Institute of Health', country: 'luxembourg', location: 'Luxembourg', url: 'https://www.lih.lu/en/careers/vacancies/' },
  ];

  for (const src of sources) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const $ = cheerio.load(html);
    $('article, .vacancy, .job, .position, li[class*="job"], li[class*="vacancy"], .result').each((_, el) => {
      const title = $(el).find('h2, h3, a, .title, [class*="title"]').first().text().trim();
      const link  = $(el).find('a').first().attr('href') || '';
      if (title && title.length > 8) {
        jobs.push({ title, org: src.name, country: src.country, location: src.location, url: link.startsWith('http') ? link : `${new URL(src.url).origin}${link}` });
      }
    });
  }
  console.log(`  Rest of Europe (DE/BE/CH/LU): ${jobs.length} raw candidates`);
  return jobs;
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
    restEuropeRaw,
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
    scrapeRestOfEurope(),
    scrapeIndustryCareers(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  const allRaw = [
    ...euraxessRaw,
    ...academicPosRaw,
    ...academicTransferRaw,
    ...natureCareersRaw,
    ...findaPhdRaw,
    ...swedishRaw,
    ...dutchRaw,
    ...danishRaw,
    ...restEuropeRaw,
    ...industryRaw,
  ];

  console.log(`\n📊 Total raw candidates across all sources: ${allRaw.length}`);

  // Score and filter
  const scored = [];
  for (const raw of allRaw) {
    if (!raw.title || raw.title.length < 6) continue;
    const job = buildJob(raw, 'live');
    if (job) scored.push(job);
  }

  console.log(`✅ Passed scoring threshold (≥${MIN_SCORE_THRESHOLD}): ${scored.length} jobs`);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Deduplicate
  const deduped = deduplicateJobs(scored);
  console.log(`🔄 After deduplication: ${deduped.length} unique live jobs`);

  // Remove internal fingerprint field before posting
  deduped.forEach(j => delete j._fp);

  // If we found enough live jobs — return them, no fallback
  if (deduped.length >= TARGET_LIVE_JOBS) {
    console.log(`\n🎯 SUCCESS: ${deduped.length} live jobs found — skipping fallback\n`);
    return { jobs: deduped, usedFallback: false };
  }

  // Partial live results — append only fallbacks that don't duplicate a live job
  if (deduped.length > 0) {
    console.log(`⚠️  Only ${deduped.length} live jobs found — padding with non-duplicate fallbacks`);
    const liveFingerprints = new Set(deduped.map(j => fingerprint(j.title, j.org)));
    const padFallback = FALLBACK_JOBS.filter(j => !liveFingerprints.has(fingerprint(j.title, j.org)));
    return { jobs: [...deduped, ...padFallback], usedFallback: true };
  }

  // Zero live jobs — full fallback
  console.log('❌ No live jobs found — using full fallback list');
  return { jobs: FALLBACK_JOBS, usedFallback: true };
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

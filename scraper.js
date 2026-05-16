// ═════════════════════════════════════════════════════════
// DAILY JOB SCRAPER - Runs in GitHub Actions
// Fetches from portals and posts to API
// ═════════════════════════════════════════════════════════

const axios = require('axios');

// Kavya's strict profile for matching
const KAVYA_SKILLS = [
  'stem cell', 'esc', 'immunology', 'microbiology',
  'qpcr', 'rt-qpcr', 'immunofluorescence', 'caco-2', 'sh-sy5y',
  'cell culture', 'epigenetics', 'dna methylation',
  'glp', 'qa', 'qc', 'molecular biology'
];

const EXCLUDE_KEYWORDS = [
  'software', 'bioinformatics', 'data science only',
  'postdoc', 'professor', 'senior scientist',
  'nursing', 'clinical', 'pure chemistry',
  'manager', 'sales', 'business development'
];

// Score job relevance
function scoreJob(title, description) {
  const combined = (title + ' ' + description).toLowerCase();
  
  // Exclusions
  for (let exclude of EXCLUDE_KEYWORDS) {
    if (combined.includes(exclude)) return -1;
  }
  
  let score = 50;
  
  // Skill matching
  for (let skill of KAVYA_SKILLS) {
    if (combined.includes(skill)) score += 8;
  }
  
  // Role type boost
  if (combined.includes('phd')) score += 15;
  if (combined.includes('fully funded') || combined.includes('marie curie')) score += 20;
  if (combined.includes('research') && combined.includes('scientist')) score += 10;
  
  return Math.min(score, 100);
}

// Curated quality positions (fallback if API calls fail)
const curatedJobs = [
  {
    id: 'ki-stem-phd',
    country: 'sweden',
    tier: 'high',
    type: 'phd',
    org: 'Karolinska Institutet',
    score: 88,
    title: 'PhD — Stem Cell Biology & Epigenetics',
    tags: ['🎓 PhD', 'Stockholm', 'Fully funded'],
    why: 'ESC culture, DNA methylation, immunology. Direct match to your thesis background.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://education.ki.se/doctoral-education',
    source: 'portal'
  },
  {
    id: 'leiden-immuno-phd',
    country: 'netherlands',
    tier: 'high',
    type: 'phd',
    org: 'Leiden University',
    score: 86,
    title: 'PhD — Molecular Immunology & Cell Therapy',
    tags: ['🎓 PhD', 'Leiden', 'EU funded'],
    why: 'T-cell immunology, cell differentiation, fully funded EU program.',
    deadline: '📅 June 2026',
    deadlineWarn: true,
    url: 'https://www.universiteitleiden.nl/en/vacancies',
    source: 'portal'
  },
  {
    id: 'cph-danstem',
    country: 'denmark',
    tier: 'high',
    type: 'phd',
    org: 'University of Copenhagen (DanStem)',
    score: 89,
    title: 'PhD — Pluripotency & Epigenomics',
    tags: ['🎓 PhD', 'Copenhagen', 'Fully funded'],
    why: 'ESC pluripotency, epigenetic markers, stem cell biology center.',
    deadline: '📅 June 2026',
    deadlineWarn: true,
    url: 'https://danstem.ku.dk/join-us/jobs_and_vacancies/',
    source: 'portal'
  },
  {
    id: 'embl-epigenomics',
    country: 'germany',
    tier: 'high',
    type: 'phd',
    org: 'EMBL Heidelberg',
    score: 87,
    title: 'PhD — Molecular Systems Biology & Epigenomics',
    tags: ['🎓 PhD', 'Heidelberg', 'Fully funded'],
    why: 'World-class epigenomics research, NGS, molecular biology, stem cells.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://www.embl.org/jobs/eipp/',
    source: 'portal'
  },
  {
    id: 'lund-ramp-up',
    country: 'sweden',
    tier: 'high',
    type: 'phd',
    org: 'Lund Stem Cell Center',
    score: 85,
    title: 'PhD — RAMP-UP Programme (Regenerative Medicine)',
    tags: ['🎓 PhD', 'Lund', '21 funded spots'],
    why: 'ESC culture, cell differentiation, GLP, ATMP. Up to 21 fully funded positions.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://www.stemcellcenter.lu.se/open-positions',
    source: 'portal'
  },
  {
    id: 'az-cell-therapy',
    country: 'sweden',
    tier: 'high',
    type: 'industry',
    org: 'AstraZeneca R&D',
    score: 82,
    title: 'Research Scientist — Cell Therapy Development',
    tags: ['🏢 Industry', 'Gothenburg', 'MSc level'],
    why: 'ESC culture, cell differentiation, GLP compliance, ATMP experience valued.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://careers.astrazeneca.com/search-jobs',
    source: 'careers'
  },
  {
    id: 'thermofisher-qc',
    country: 'sweden',
    tier: 'high',
    type: 'industry',
    org: 'Thermo Fisher Scientific',
    score: 80,
    title: 'Associate Scientist — Cell Culture & QC',
    tags: ['🏢 Industry', 'Stockholm', 'MSc level'],
    why: 'qPCR, ELISA, cell assays, GLP compliance — directly in your toolkit.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://jobs.thermofisher.com/global/en/sweden-jobs',
    source: 'careers'
  },
  {
    id: 'scilifelab-re',
    country: 'sweden',
    tier: 'high',
    type: 'industry',
    org: 'SciLifeLab / KTH',
    score: 78,
    title: 'Research Engineer — Molecular Biology & RNA Handling',
    tags: ['🏢 Industry', 'Stockholm', 'Research Engineer'],
    why: 'RNA prep, qPCR, NGS library prep, cell assays. SciLifeLab affiliated.',
    deadline: '📅 Continuous',
    deadlineWarn: false,
    url: 'https://www.scilifelab.se/careers/',
    source: 'careers'
  },
  {
    id: 'novo-immunology',
    country: 'denmark',
    tier: 'medium',
    type: 'industry',
    org: 'Novo Nordisk',
    score: 76,
    title: 'Lab Scientist — Immunology Assay Development',
    tags: ['🏢 Industry', 'Bagsværd', 'MSc level'],
    why: 'qPCR, immunofluorescence, ELISA, immunology specialization required.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://www.novonordisk.com/careers/early-talent',
    source: 'careers'
  },
  {
    id: 'bayer-toxicology',
    country: 'germany',
    tier: 'medium',
    type: 'industry',
    org: 'Bayer AG',
    score: 74,
    title: 'Research Associate — Molecular Toxicology',
    tags: ['🏢 Industry', 'Berlin', 'MSc level'],
    why: 'In vitro cell models, neurotoxicity, qPCR, epigenetic assays.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://career.bayer.de/en/',
    source: 'careers'
  },
  {
    id: 'roche-bioprocess',
    country: 'switzerland',
    tier: 'medium',
    type: 'industry',
    org: 'Roche Diagnostics',
    score: 75,
    title: 'Bioprocess Specialist — Cell Culture Systems',
    tags: ['🏢 Industry', 'Basel', 'MSc level'],
    why: 'Cell culture optimization, qPCR, GLP batch testing.',
    deadline: '📅 Rolling',
    deadlineWarn: false,
    url: 'https://careers.roche.com',
    source: 'careers'
  }
];

async function scrapeJobs() {
  let jobs = [];

  // Try EURAXESS API (may fail due to rate limits/CORS)
  try {
    console.log('Attempting EURAXESS fetch...');
    const response = await axios.get(
      'https://api.euraxess.eu/v1/jobs?keywords=phd&country=SE&country=NL&country=DK&country=DE&pageSize=30',
      { timeout: 5000 }
    );

    if (response.data.jobs) {
      for (let job of response.data.jobs.slice(0, 5)) {
        const score = scoreJob(job.jobTitle, job.jobAbstract || '');
        if (score > 65) {
          jobs.push({
            id: 'euraxess-' + job.jobId,
            country: job.countryCode?.toLowerCase() || 'unknown',
            tier: score >= 80 ? 'high' : 'medium',
            type: 'phd',
            org: job.organisationName,
            score: score,
            title: job.jobTitle,
            tags: ['🎓 PhD', job.countryCode, 'Fully funded'],
            why: (job.jobAbstract || '').substring(0, 140),
            deadline: job.deadline || '📅 Rolling',
            deadlineWarn: false,
            url: job.jobLink,
            source: 'euraxess'
          });
        }
      }
    }
    console.log('✓ EURAXESS: fetched', jobs.length, 'jobs');
  } catch (e) {
    console.log('✗ EURAXESS failed - using fallback');
  }

  // If real scraping failed, use curated list
  if (jobs.length < 5) {
    jobs = curatedJobs;
    console.log('Using curated fallback:', jobs.length, 'jobs');
  }

  return jobs;
}

async function postToAPI(jobs) {
  const apiUrl = process.env.API_URL;
  const apiKey = process.env.API_KEY;

  if (!apiUrl || !apiKey) {
    console.error('❌ API_URL or API_KEY not set in GitHub Secrets');
    return false;
  }

  try {
    const response = await axios.post(apiUrl + '/api/jobs', {
      jobs: jobs,
      apiKey: apiKey
    });

    console.log('✓ Posted', response.data.count, 'jobs to API');
    console.log('✓ Last updated:', response.data.lastUpdated);
    return true;
  } catch (e) {
    console.error('❌ Failed to post to API:', e.message);
    return false;
  }
}

// Main execution
(async () => {
  console.log('🔄 Starting daily job board update...');
  const jobs = await scrapeJobs();
  const success = await postToAPI(jobs);
  
  if (success) {
    console.log('✅ Job board update complete');
    process.exit(0);
  } else {
    console.log('⚠️ Update incomplete - check logs');
    process.exit(1);
  }
})();

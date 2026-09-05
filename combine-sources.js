// combine-sources.js
// Merges results from every configured agency into ONE array with a
// consistent schema. This is deliberately simple — per the earlier design
// decision, the combiner's job is just concatenation; making sure each
// source honestly produces the shared schema is what the per-agency
// scraper files (scrape-runner.js) are responsible for.
//
// Each source is wrapped in its own try/catch so one agency failing
// (e.g. Barnes' site changing) can't take down the others — the run
// still produces results for whatever worked, with per-source status
// visible in the output rather than a silent gap.
//
// FIX (this pass): SeLoger removed entirely — the site's own scraper
// (seloger-scraper.js), suburb scraper, and arrondissement scraper are
// deleted, along with the ~80-shard GitHub Actions matrix that ran them.
// That was by far the largest chunk of the CI pipeline's job budget.
//
// Also added `excludeBarnes`, mirroring excludeDanielFeau/
// excludeEiffelHousing/excludeJunot. Barnes now runs as its own isolated
// job (scrape-single-barnes.js) instead of inside scrape-main's shared
// 15-minute budget — its live listing count (146 rent / 938 sale) plus
// per-listing detail-page enrichment made it a real risk of the same
// "job times out mid-run, writes nothing at all" failure DanielFeau/
// Eiffel Housing/Junot already hit before being isolated. The SeLoger
// removal above frees up enough CI job-slot budget to give Barnes that
// same isolated treatment without growing the pipeline's total footprint.

const { scrapeBarnes } = require('./scrape-runner');
const { scrapeJunot } = require('./junot-scraper');
const { scrapeBarnesSuburbs } = require('./barnes-suburbs-scraper');
const { scrapeBookAFlat } = require('./bookaflat-scraper');
const { scrapePerenium } = require('./perenium-scraper');
const { scrapeParisRental } = require('./parisrental-scraper');
const { scrapeDanielFeau } = require('./danielfeau-scraper');
const { scrapeEiffelHousing } = require('./eiffel-housing-scraper');
const { scrapeOrpi } = require('./orpi-scraper');
const { scrapeParisSeineImmobilier } = require('./paris-seine-immobilier-scraper');
const { scrapePatrimoineOuestParisien } = require('./patrimoine-ouest-parisien-scraper');
const { scrapeAFRImmobilier } = require('./afr-immobilier-scraper');
const { scrapeHelixImmobilier } = require('./helix-immobilier-scraper');
const { scrapeBloomingHome } = require('./bloominghome-scraper');
const { scrapeNicolasDevillard } = require('./nicolas-devillard-scraper');
const { scrapeTiemo } = require('./tiemo-scraper');
const { scrapeEmileGarcin } = require('./emile-garcin-scraper');
const { scrapeEngelVolkers } = require('./engel-volkers-scraper');
const { scrapeJohnTaylor } = require('./john-taylor-scraper');
const { scrapeBreteuilHomes } = require('./breteuil-homes-scraper');
const { scrapeSothebys } = require('./sothebys-scraper');
const { scrapeDynagest } = require('./dynagest-scraper');
const { scrapeLuxePrestigeImmo } = require('./luxe-prestige-immo-scraper');
const { scrapePalaisRoyalImmobilier } = require('./palais-royal-immobilier-scraper');
const { scrapeQuodEtAssocies } = require('./quod-et-associes-scraper');
const { scrapePatrimoineImmo } = require('./patrimoine-immo-scraper');
const { scrapeFredelion } = require('./fredelion-scraper');
const { scrapeEnaparte } = require('./enaparte-scraper');

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

const PER_SOURCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// FIX (2026-09-03): a source that came back with 0 listings (rate
// limiting, a temporary defensive trigger, a transient site issue) had
// exactly one shot per day — if that one attempt got blocked, the whole
// day's data for that source was gone, even though the SAME source
// worked fine the day before and after with zero code changes. Live
// evidence: Patrimoine Ouest Parisien and AFR Immobilier went 59/31
// listings -> 0/0 -> (confirmed unchanged code) purely run-to-run.
// That's the signature of a transient block, not a permanent one — and
// transient blocks are exactly what a retry with backoff can recover
// from. Each attempt gets a genuinely fresh browser/session (every
// scraper launches its own browser internally), which won't help
// against a hard IP ban, but will against session- or request-pattern
// based rate limiting, which is far more common for small sites without
// enterprise-grade bot infrastructure.
//
// This does NOT guarantee every source succeeds every time — no
// scraper honestly can, against a site that's actively trying to block
// automated traffic. It meaningfully raises the odds of recovering from
// the kind of here-today-gone-tomorrow flakiness we've actually seen,
// without pretending to solve a problem that isn't fully solvable.
const MAX_ATTEMPTS_ON_ZERO = 3; // 1 initial + 2 retries
const RETRY_BASE_DELAY_MS = 20 * 1000; // 20s, 40s (with jitter) between attempts

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSource(label, promiseFactory, results, sourceStatus) {
  let lastResult = null;
  let lastError = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_ON_ZERO; attempt++) {
    attemptsUsed = attempt;
    try {
      const attemptLabel = attempt === 1 ? '' : ` (retry ${attempt - 1}/${MAX_ATTEMPTS_ON_ZERO - 1})`;
      console.log(`\n=== Scraping ${label}${attemptLabel} ===`);
      const result = await withTimeout(promiseFactory(), PER_SOURCE_TIMEOUT_MS, `${label} scrape`);
      lastResult = result;
      lastError = null;

      if (result.error) {
        console.warn(`${label}: attempt ${attempt} returned an error: ${result.error}`);
      } else if (result.listings.length === 0 && attempt < MAX_ATTEMPTS_ON_ZERO) {
        console.warn(`${label}: attempt ${attempt} returned 0 listings — could be a transient block or genuinely zero today. Retrying after a delay before assuming it's real.`);
      } else {
        // Either got real listings, or this was the last allowed
        // attempt (0 listings with no more retries left) — done either way.
        break;
      }
    } catch (error) {
      lastError = error;
      console.error(`${label}: attempt ${attempt} threw unexpectedly (or hung and was timed out): ${error.message}`);
    }

    if (attempt < MAX_ATTEMPTS_ON_ZERO) {
      const delay = RETRY_BASE_DELAY_MS * attempt + Math.floor(Math.random() * 5000);
      console.log(`${label}: waiting ${(delay / 1000).toFixed(0)}s before retrying...`);
      await sleep(delay);
    }
  }

  if (lastResult && !lastResult.error) {
    // NEW (2026-09-03): stamp every listing with when THIS specific
    // source's scrape actually completed, not just a single batch-wide
    // timestamp. Different sources in the same run can finish minutes
    // (or, for isolated jobs, over an hour) apart, and this is what
    // powers the frontend's per-listing "Pulled" column.
    const scrapedAt = new Date().toISOString();
    lastResult.listings.forEach(l => { l.scrapedAt = scrapedAt; });
    results.push(...lastResult.listings);
    sourceStatus.push({ source: label, found: lastResult.listings.length, error: null, attempts: attemptsUsed });
  } else {
    const errorMsg = (lastResult && lastResult.error) || (lastError && lastError.message) || 'Unknown error after retries';
    sourceStatus.push({ source: label, found: 0, error: errorMsg, attempts: attemptsUsed });
  }
}

async function combineAllSources(searchType = 'rent', options = {}) {
  const {
    fetchDetails = false,
    excludeBarnes = false, // NEW
    excludeOrpi = false, // NEW
    excludeParisRental = false,
    excludeDanielFeau = false,
    excludeEiffelHousing = false,
    excludeJunot = false,
    externalListings = [],
    externalSourceStatus = []
  } = options;
  const results = [...externalListings];
  const sourceStatus = [...externalSourceStatus];

  // Barnes: moved to its own isolated job (like DanielFeau/Eiffel Housing/
  // Junot) — see scrape-single-barnes.js. Excluded here when called from
  // scrape-main-sources.js; still available for ad-hoc/manual runs of the
  // full combiner.
  if (!excludeBarnes) {
    await runSource('Barnes', () => scrapeBarnes(searchType, { fetchDetails }), results, sourceStatus);
  }
  await runSource('Barnes-Suburbs', () => scrapeBarnesSuburbs(searchType), results, sourceStatus);

  // Junot: its own isolated job (like DanielFeau/Eiffel Housing) after
  // adding real detail-page enrichment for furnished status — enriching
  // up to 849 real sale listings at a cautious rate needs more time than
  // scrape-main's shared budget can comfortably afford. See
  // scrape-single-junot.js and the corresponding scrape-deploy.yml job.
  if (!excludeJunot) {
    await runSource('Junot', () => scrapeJunot(searchType), results, sourceStatus);
  }

  await runSource('Book-a-Flat', () => scrapeBookAFlat(searchType), results, sourceStatus);
  await runSource('Perenium', () => scrapePerenium(searchType), results, sourceStatus);
  // Three agencies on the Orisha/Poliris platform — modest inventories
  // (30-60 listings each), no detail-fetch-driven timeout risk, so these
  // stay in the shared job rather than getting isolated like Barnes/Orpi.
  await runSource('Paris Seine Immobilier', () => scrapeParisSeineImmobilier(searchType), results, sourceStatus);
  await runSource('Patrimoine Ouest Parisien', () => scrapePatrimoineOuestParisien(searchType), results, sourceStatus);
  await runSource('AFR Immobilier', () => scrapeAFRImmobilier(searchType), results, sourceStatus);
  await runSource('Helix Immobilier', () => scrapeHelixImmobilier(searchType), results, sourceStatus);
  await runSource('Blooming Home', () => scrapeBloomingHome(searchType), results, sourceStatus);
  await runSource('Nicolas Devillard', () => scrapeNicolasDevillard(searchType), results, sourceStatus);
  await runSource('Tiemo', () => scrapeTiemo(searchType), results, sourceStatus);
  await runSource('Emile Garcin', () => scrapeEmileGarcin(searchType), results, sourceStatus);
  await runSource('Engel & Völkers', () => scrapeEngelVolkers(searchType), results, sourceStatus);
  await runSource('John Taylor', () => scrapeJohnTaylor(searchType), results, sourceStatus);
  await runSource('Breteuil Homes', () => scrapeBreteuilHomes(searchType), results, sourceStatus);
  await runSource("Sotheby's", () => scrapeSothebys(searchType), results, sourceStatus);
  await runSource('Dynagest', () => scrapeDynagest(searchType), results, sourceStatus);
  await runSource('Luxe Prestige Immo', () => scrapeLuxePrestigeImmo(searchType), results, sourceStatus);
  await runSource('Palais Royal Immobilier', () => scrapePalaisRoyalImmobilier(searchType), results, sourceStatus);
  await runSource('Quod et Associés', () => scrapeQuodEtAssocies(searchType), results, sourceStatus);
  await runSource('Patrimoine Immo', () => scrapePatrimoineImmo(searchType), results, sourceStatus);
  await runSource('Fredelion', () => scrapeFredelion(searchType), results, sourceStatus);
  await runSource('Enaparte Paris', () => scrapeEnaparte(searchType), results, sourceStatus);
  // Orpi: own isolated job (like Barnes/DanielFeau/Eiffel Housing/Junot) —
  // its confirmed live sale volume (451 listings, 31 pages) plus
  // per-listing detail-page enrichment is too large for scrape-main's
  // shared budget. See scrape-single-orpi.js.
  if (!excludeOrpi) {
    await runSource('Orpi', () => scrapeOrpi(searchType), results, sourceStatus);
  }
  if (!excludeParisRental) {
    await runSource('ParisRental', () => scrapeParisRental(searchType), results, sourceStatus);
  }
  if (!excludeDanielFeau) {
    await runSource('DanielFeau', () => scrapeDanielFeau(searchType), results, sourceStatus);
  }
  if (!excludeEiffelHousing) {
    await runSource('Eiffel Housing', () => scrapeEiffelHousing(searchType), results, sourceStatus);
  }

  return {
    searchType,
    fetchDetails,
    generatedAt: new Date().toISOString(),
    totalListings: results.length,
    sourceStatus,
    listings: results
  };
}

module.exports = { combineAllSources };

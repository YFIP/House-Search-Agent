// combine-sources.js
// Merges results from every configured agency into ONE array with a
// consistent schema. This is deliberately simple — per the earlier design
// decision, the combiner's job is just concatenation; making sure each
// source honestly produces the shared schema is what the per-agency
// scraper files (scrape-runner.js, seloger-scraper.js) are responsible for.
//
// Each source is wrapped in its own try/catch so one agency failing (e.g.
// SeLoger eventually getting blocked, Barnes' site changing) can't take
// down the others — the run still produces results for whatever worked,
// with per-source status visible in the output rather than a silent gap.
//
// FIX (this pass): added `excludeJunot`, mirroring excludeDanielFeau/
// excludeEiffelHousing. Junot now does real detail-page enrichment (to
// recover furnished status — see junot-scraper.js), which means it needs
// the same isolated-job treatment as those two sources rather than
// running inside scrape-main's shared 15-minute budget. See
// scrape-single-junot.js and the corresponding scrape-deploy.yml job.

const { scrapeBarnes } = require('./scrape-runner');
const { scrapeSeLoger } = require('./seloger-scraper');
const { scrapeJunot } = require('./junot-scraper');
const { scrapeBarnesSuburbs } = require('./barnes-suburbs-scraper');
const { scrapeSeLogerSuburbs } = require('./seloger-suburbs-scraper');
const { scrapeBookAFlat } = require('./bookaflat-scraper');
const { scrapePerenium } = require('./perenium-scraper');
const { scrapeParisRental } = require('./parisrental-scraper');
const { scrapeDanielFeau } = require('./danielfeau-scraper');
const { scrapeEiffelHousing } = require('./eiffel-housing-scraper');

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

const PER_SOURCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function runSource(label, promiseFactory, results, sourceStatus) {
  try {
    console.log(`\n=== Scraping ${label} ===`);
    const result = await withTimeout(promiseFactory(), PER_SOURCE_TIMEOUT_MS, `${label} scrape`);
    if (result.error) {
      sourceStatus.push({ source: label, found: 0, error: result.error });
    } else {
      results.push(...result.listings);
      sourceStatus.push({ source: label, found: result.listings.length, error: null });
    }
  } catch (error) {
    console.error(`${label} threw unexpectedly (or hung and was timed out):`, error.message);
    sourceStatus.push({ source: label, found: 0, error: error.message });
  }
}

async function combineAllSources(searchType = 'rent', options = {}) {
  const {
    fetchDetails = false,
    excludeSeLoger = false,
    excludeSeLogerSuburbs = false,
    excludeParisRental = false,
    excludeDanielFeau = false,
    excludeEiffelHousing = false,
    excludeJunot = false, // NEW
    externalListings = [],
    externalSourceStatus = []
  } = options;
  const results = [...externalListings];
  const sourceStatus = [...externalSourceStatus];

  await runSource('Barnes', () => scrapeBarnes(searchType, { fetchDetails }), results, sourceStatus);
  await runSource('Barnes-Suburbs', () => scrapeBarnesSuburbs(searchType), results, sourceStatus);

  // Junot: moved to its own isolated job (like DanielFeau/Eiffel Housing)
  // after adding real detail-page enrichment for furnished status —
  // enriching up to 849 real sale listings at a cautious rate needs more
  // time than scrape-main's shared budget can comfortably afford.
  if (!excludeJunot) {
    await runSource('Junot', () => scrapeJunot(searchType), results, sourceStatus);
  }

  if (!excludeSeLoger) {
    await runSource('SeLoger', () => scrapeSeLoger(searchType), results, sourceStatus);
  }
  if (!excludeSeLogerSuburbs) {
    await runSource('SeLoger-Suburbs', () => scrapeSeLogerSuburbs(searchType), results, sourceStatus);
  }

  await runSource('Book-a-Flat', () => scrapeBookAFlat(searchType), results, sourceStatus);
  await runSource('Perenium', () => scrapePerenium(searchType), results, sourceStatus);
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

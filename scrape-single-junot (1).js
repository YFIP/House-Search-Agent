// scrape-single-junot.js
//
// NEW FILE. Runs Junot in complete isolation, as its own GitHub Actions
// job — same reasoning as scrape-single-danielfeau.js and
// scrape-single-eiffel-housing.js: junot-scraper.js now does real
// detail-page enrichment (added to recover furnished status, which
// isn't present in the summary card — see junot-scraper.js's header
// comment for the live evidence). Junot covers ~50 locations and up to
// 849 real sale listings, so enriching all of them at a cautious rate
// needs more time than scrape-main's shared 15-minute budget can
// comfortably afford — exactly the pattern that already forced
// DanielFeau/Eiffel Housing/SeLoger out of that shared job.
//
// Usage:
//   node scrape-single-junot.js rent
//   node scrape-single-junot.js sale
//
// Writes its result to output-junot.json or output-junot-sale.json —
// becomes a GitHub Actions artifact that merge-and-generate.js
// downloads and combines with everything else.
const fs = require('fs');
const { scrapeJunot } = require('./junot-scraper');
async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  console.log(`[Junot] Scraping ${searchType} in isolation (own process, own job)...`);
  const start = Date.now();
  const result = await scrapeJunot(searchType);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Junot] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);
  const filename = searchType === 'sale' ? 'output-junot-sale.json' : 'output-junot.json';
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[Junot] Wrote ${filename}`);
}
main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

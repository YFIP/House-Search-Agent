// scrape-single-orpi.js
//
// NEW FILE. Runs Orpi in complete isolation, as its own GitHub Actions
// job — same reasoning as scrape-single-barnes.js/scrape-single-junot.js:
// Orpi's sale inventory (451 listings, 31 pages, confirmed live) plus
// per-listing detail-page enrichment (concurrency 3) is far too large
// for scrape-main's shared 15-minute budget.
//
// Usage:
//   node scrape-single-orpi.js rent
//   node scrape-single-orpi.js sale
//
// Writes its result to output-orpi.json or output-orpi-sale.json —
// becomes a GitHub Actions artifact that merge-and-generate.js
// downloads and combines with everything else.
const fs = require('fs');
const { scrapeOrpi } = require('./orpi-scraper');
async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  console.log(`[Orpi] Scraping ${searchType} in isolation (own process, own job)...`);
  const start = Date.now();
  const result = await scrapeOrpi(searchType);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Orpi] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);
  const filename = searchType === 'sale' ? 'output-orpi-sale.json' : 'output-orpi.json';
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[Orpi] Wrote ${filename}`);
}
main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

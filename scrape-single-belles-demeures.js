// scrape-single-belles-demeures.js
//
// NEW FILE. Runs Belles Demeures in complete isolation, as its own
// GitHub Actions job — same reasoning as scrape-single-barnes.js/
// scrape-single-orpi.js: confirmed 238 listings in just the 16th
// arrondissement alone means this is likely thousands of listings
// across all 20, with per-listing detail-page enrichment on top — far
// too large for scrape-main's shared budget.
//
// Usage:
//   node scrape-single-belles-demeures.js rent
//   node scrape-single-belles-demeures.js sale
//
// Writes its result to output-belles-demeures.json or
// output-belles-demeures-sale.json — becomes a GitHub Actions artifact
// that merge-and-generate.js downloads and combines with everything else.
const fs = require('fs');
const { scrapeBellesDemeures } = require('./belles-demeures-scraper');
async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  console.log(`[Belles Demeures] Scraping ${searchType} in isolation (own process, own job)...`);
  const start = Date.now();
  const result = await scrapeBellesDemeures(searchType);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Belles Demeures] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);
  const filename = searchType === 'sale' ? 'output-belles-demeures-sale.json' : 'output-belles-demeures.json';
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[Belles Demeures] Wrote ${filename}`);
}
main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

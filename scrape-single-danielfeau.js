// scrape-single-danielfeau.js
//
// Scrapes DanielFeau in complete isolation, as its own GitHub Actions
// job. Moved out of scrape-main after adding real detail-page
// enrichment for elevator/furnished/bathroom info — DanielFeau can have
// up to 600 listings, and enriching all of them with a cautious,
// anti-bot-safe approach (low concurrency, small delays) needs more
// time than scrape-main's shared 15-minute budget with Barnes/Junot/
// SeLoger-main can comfortably afford.
//
// Usage:
//   node scrape-single-danielfeau.js rent
//   node scrape-single-danielfeau.js sale
//
// Writes its result to output-danielfeau.json or
// output-danielfeau-sale.json — becomes a GitHub Actions artifact that
// merge-and-generate.js downloads and combines with everything else.

const fs = require('fs');
const { scrapeDanielFeau } = require('./danielfeau-scraper');

async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';

  console.log(`[DanielFeau] Scraping ${searchType} in isolation (own process, own job)...`);
  const start = Date.now();
  const result = await scrapeDanielFeau(searchType);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[DanielFeau] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);

  const filename = searchType === 'sale' ? 'output-danielfeau-sale.json' : 'output-danielfeau.json';
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[DanielFeau] Wrote ${filename}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

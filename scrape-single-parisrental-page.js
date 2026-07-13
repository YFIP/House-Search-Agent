// scrape-single-parisrental-page.js
// Scrapes ONE page of ONE ParisRental category in isolation — same
// pattern as scrape-single-seloger-suburb.js. Meant to run as its own
// GitHub Actions matrix job (own runner, own session), tried after the
// combined scraper returned 0 results specifically on GitHub Actions
// while working fine from a home network with identical code — strong
// evidence GitHub's IP range is being blocked. Not guaranteed to help
// (this may be a straightforward IP block, which isolation doesn't fix
// the way it fixed SeLoger's session-pattern issue), but worth testing.
//
// Usage:
//   node scrape-single-parisrental-page.js furnished 1
//   node scrape-single-parisrental-page.js unfurnished 1

const fs = require('fs');
const { scrapeSinglePage } = require('./parisrental-scraper');

async function main() {
  const category = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);

  if (!category || !pageNum) {
    console.error('Usage: node scrape-single-parisrental-page.js <furnished|unfurnished> <page-number>');
    process.exit(1);
  }

  console.log(`[ParisRental-${category}-${pageNum}] Scraping in isolation...`);
  const start = Date.now();
  const result = await scrapeSinglePage(category, pageNum, 'rent');
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[ParisRental-${category}-${pageNum}] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);

  const filename = `output-parisrental-${category}-${pageNum}.json`;
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[ParisRental-${category}-${pageNum}] Wrote ${filename}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

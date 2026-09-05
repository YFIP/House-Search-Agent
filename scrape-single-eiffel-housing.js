// scrape-single-eiffel-housing.js
//
// Scrapes Eiffel Housing in complete isolation, as its own GitHub
// Actions job. Moved out of scrape-main after adding real detail-page
// enrichment for bathroom info — confirmed live that scrape-main got
// cancelled at its 15-minute timeout while still mid-way through Eiffel
// Housing's enrichment step (152 listings), which didn't exist before
// and wasn't accounted for in the shared budget with Barnes/Junot/
// SeLoger-main/Perenium/Book-a-Flat.
//
// Usage:
//   node scrape-single-eiffel-housing.js rent
//   node scrape-single-eiffel-housing.js sale
//
// Writes its result to output-eiffel-housing.json or
// output-eiffel-housing-sale.json — becomes a GitHub Actions artifact
// that merge-and-generate.js downloads and combines with everything else.

const fs = require('fs');
const { scrapeEiffelHousing } = require('./eiffel-housing-scraper');

async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';

  console.log(`[Eiffel Housing] Scraping ${searchType} in isolation (own process, own job)...`);
  const start = Date.now();
  const result = await scrapeEiffelHousing(searchType);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[Eiffel Housing] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);

  const filename = searchType === 'sale' ? 'output-eiffel-housing-sale.json' : 'output-eiffel-housing.json';
  // NEW (2026-09-03): stamp when this isolated job's scrape actually
  // completed onto every listing — powers the frontend's per-listing
  // "Pulled" column.
  const scrapedAt = new Date().toISOString();
  result.listings.forEach(l => { l.scrapedAt = scrapedAt; });
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[Eiffel Housing] Wrote ${filename}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

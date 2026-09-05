// scrape-single-barnes.js
//
// NEW FILE. Runs Barnes in complete isolation, as its own GitHub Actions
// job — same reasoning as scrape-single-danielfeau.js/
// scrape-single-eiffel-housing.js/scrape-single-junot.js: scrape-runner.js
// does real click-until-exhausted pagination (up to 146 rent / 938 sale
// live listings) plus per-listing detail-page enrichment by default
// (fetchDetails defaults to true — see scrape-runner.js), which needs
// more time than scrape-main's shared 15-minute budget can comfortably
// afford now that it's also running Barnes-Suburbs/Book-a-Flat/Perenium
// in that same window.
//
// This became affordable once SeLoger (and its ~80-shard matrix) was
// removed from the pipeline entirely — see combine-sources.js.
//
// Usage:
//   node scrape-single-barnes.js rent
//   node scrape-single-barnes.js sale
//
// Writes its result to output-barnes.json or output-barnes-sale.json —
// becomes a GitHub Actions artifact that merge-and-generate.js
// downloads and combines with everything else.
const fs = require('fs');
const { scrapeBarnes } = require('./scrape-runner');
async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  console.log(`[Barnes] Scraping ${searchType} in isolation (own process, own job)...`);
  const start = Date.now();
  const result = await scrapeBarnes(searchType);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Barnes] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);
  const filename = searchType === 'sale' ? 'output-barnes-sale.json' : 'output-barnes.json';
  // NEW (2026-09-03): stamp when this isolated job's scrape actually
  // completed onto every listing — powers the frontend's per-listing
  // "Pulled" column.
  const scrapedAt = new Date().toISOString();
  result.listings.forEach(l => { l.scrapedAt = scrapedAt; });
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[Barnes] Wrote ${filename}`);
}
main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

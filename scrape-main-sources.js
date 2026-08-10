// scrape-main-sources.js
// Runs Barnes, Barnes-Suburbs, Book-a-Flat, and Perenium — everything
// EXCEPT SeLoger, SeLoger-Suburbs, ParisRental, DanielFeau, Eiffel
// Housing, AND (as of this pass) Junot, which all run as separate
// isolated jobs — see scrape-single-seloger.js,
// scrape-single-seloger-suburb.js, scrape-single-parisrental-page.js,
// scrape-single-danielfeau.js, scrape-single-eiffel-housing.js, and
// scrape-single-junot.js — to keep this shared job's runtime predictable
// and avoid the "job timed out mid-enrichment, wrote nothing at all"
// failure mode that hit DanielFeau and Eiffel Housing before they were
// isolated.
//
// FIX (this pass): Junot moved out. It now does real detail-page
// enrichment (added to recover furnished status — see
// junot-scraper.js), covers ~50 locations with up to 849 real sale
// listings, and was still running inside this shared 15-minute job —
// exactly the situation that already caused DanielFeau/Eiffel Housing to
// silently produce no output on busy runs. See scrape-single-junot.js
// and the corresponding scrape-deploy.yml job.
//
// SeLoger (Paris-wide) is deliberately NOT run here or anywhere in this
// pipeline: its own page/result cap was removed (uncapped by design),
// which made a full run both too slow for any single job budget AND
// almost entirely redundant — the per-arrondissement matrix already
// covers all of Paris with its own enrichment.
const fs = require('fs');
const { combineAllSources } = require('./combine-sources');
async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  const fetchDetails = process.argv[3] === 'details';
  console.log(`Scraping main sources for ${searchType}${fetchDetails ? ' (with detail enrichment)' : ''} (SeLoger, SeLoger-Suburbs, ParisRental, DanielFeau, Eiffel Housing, and Junot excluded — run separately)...`);
  const data = await combineAllSources(searchType, {
    fetchDetails,
    excludeSeLoger: true,
    excludeSeLogerSuburbs: true,
    excludeParisRental: true,
    excludeDanielFeau: true,
    excludeEiffelHousing: true,
    excludeJunot: true // NEW
  });
  console.log(`\nMain sources total: ${data.totalListings}`);
  data.sourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));
  const outputFilename = searchType === 'sale' ? 'output-main-sale.json' : 'output-main.json';
  fs.writeFileSync(outputFilename, JSON.stringify(data, null, 2));
  console.log(`\n✅ Wrote ${outputFilename}`);
}
main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

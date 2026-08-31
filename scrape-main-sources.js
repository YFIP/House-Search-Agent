// scrape-main-sources.js
// Runs Barnes-Suburbs, Book-a-Flat, and Perenium — everything EXCEPT
// ParisRental, DanielFeau, Eiffel Housing, Junot, and (as of this pass)
// Barnes, which all run as separate isolated jobs — see
// scrape-single-parisrental-page.js, scrape-single-danielfeau.js,
// scrape-single-eiffel-housing.js, scrape-single-junot.js, and
// scrape-single-barnes.js — to keep this shared job's runtime predictable
// and avoid the "job timed out mid-run, wrote nothing at all" failure
// mode that hit DanielFeau and Eiffel Housing before they were isolated.
//
// FIX (this pass): SeLoger is gone entirely (scraper, suburb scraper,
// arrondissement scraper, and their ~80-shard GitHub Actions matrix all
// deleted), and that freed-up CI job-slot budget is what makes it
// affordable to also move Barnes out to its own isolated job. Barnes'
// live listing count (146 rent / 938 sale) plus its per-listing
// detail-page enrichment step made it a real risk of the same
// mid-run-timeout failure that already forced DanielFeau/Eiffel
// Housing/Junot out of this shared job — this closes that gap rather
// than leaving Barnes exposed to it.
const fs = require('fs');
const { combineAllSources } = require('./combine-sources');
async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  const fetchDetails = process.argv[3] === 'details';
  console.log(`Scraping main sources for ${searchType}${fetchDetails ? ' (with detail enrichment)' : ''} (Barnes, Orpi, ParisRental, DanielFeau, Eiffel Housing, and Junot excluded — run separately)...`);
  const data = await combineAllSources(searchType, {
    fetchDetails,
    excludeBarnes: true, // NEW — now runs in its own isolated job
    excludeOrpi: true, // NEW — now runs in its own isolated job
    excludeParisRental: true,
    excludeDanielFeau: true,
    excludeEiffelHousing: true,
    excludeJunot: true
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

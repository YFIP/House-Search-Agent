// scrape-main-sources.js
// Runs Barnes, Barnes-Suburbs, Junot, and SeLoger (Paris) — everything
// EXCEPT SeLoger-Suburbs and ParisRental, which run as separate isolated
// matrix jobs (see scrape-single-seloger-suburb.js and
// scrape-single-parisrental-category.js) to test whether giving each its
// own GitHub Actions runner/session avoids anti-bot blocking.
//
// Writes its result to output-main.json — a later job downloads this
// alongside all the individual JSON files and merges everything into the
// final Excel file.

const fs = require('fs');
const { combineAllSources } = require('./combine-sources');

async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  const fetchDetails = process.argv[3] === 'details';

  console.log(`Scraping main sources for ${searchType}${fetchDetails ? ' (with detail enrichment)' : ''} (SeLoger-Suburbs and ParisRental excluded — run separately)...`);
  const data = await combineAllSources(searchType, { fetchDetails, excludeSeLogerSuburbs: true, excludeParisRental: true, excludeDanielFeau: true, excludeEiffelHousing: true });

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

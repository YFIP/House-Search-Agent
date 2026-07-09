// scrape-main-sources.js
// Runs Barnes, Barnes-Suburbs, Junot, and SeLoger (Paris) — everything
// EXCEPT SeLoger-Suburbs, which runs as separate isolated matrix jobs
// (see scrape-single-seloger-suburb.js) to test whether giving each
// suburb its own GitHub Actions runner/session avoids SeLoger's apparent
// anti-bot pattern detection (evidence: search #1-2 in a session always
// succeed, #3+ never do, regardless of concurrency/delay/browser-freshness
// tried within one process).
//
// Writes its result to output-main.json — a later job downloads this
// alongside all the individual suburb JSON files and merges everything
// into the final Excel file.

const fs = require('fs');
const { combineAllSources } = require('./combine-sources');

async function main() {
  const searchType = process.argv[2] === 'purchase' ? 'purchase' : 'rent';
  const fetchDetails = process.argv[3] === 'details';

  console.log(`Scraping main sources for ${searchType}${fetchDetails ? ' (with detail enrichment)' : ''} (SeLoger-Suburbs excluded — runs separately)...`);
  const data = await combineAllSources(searchType, { fetchDetails, excludeSeLogerSuburbs: true });

  console.log(`\nMain sources total: ${data.totalListings}`);
  data.sourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));

  fs.writeFileSync('output-main.json', JSON.stringify(data, null, 2));
  console.log('\n✅ Wrote output-main.json');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

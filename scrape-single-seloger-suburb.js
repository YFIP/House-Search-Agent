// scrape-single-seloger-suburb.js
//
// Scrapes ONE SeLoger suburb town, in complete isolation from the others.
// Designed to run as its own separate GitHub Actions matrix job (its own
// runner, its own IP) — the theory being tested: SeLoger's anti-bot system
// flags a SESSION that queries many distinct location searches in
// sequence (evidence: search #1-2 always succeed, #3+ never do, across
// every concurrency/delay/browser-freshness variant tried). If that's the
// real trigger, giving each suburb its own isolated session (not just its
// own browser process within one session) should let each one land in the
// "first search of the session" position that's worked reliably so far.
//
// Usage:
//   node scrape-single-seloger-suburb.js neuilly-sur-seine rent 0 2
//   (neuilly-sur-seine, rent, shard 0 of 2)
//
// shardIndex/shardCount default to 0/1 (single job, old behavior) when
// omitted. See seloger-suburbs-scraper.js's scrapeTown for why sharding
// exists: the busiest towns have over a thousand listings, and enriching
// all of them in one job takes far longer than any reasonable job
// timeout — shards split that work across parallel isolated jobs.
//
// Writes its result to output-seloger-{slug}-shard-{shardIndex}.json —
// this becomes a GitHub Actions artifact that a later job downloads and
// merges with everything else.

const fs = require('fs');
const { scrapeTown, SUBURB_TOWNS } = require('./seloger-suburbs-scraper');

async function main() {
  const slug = process.argv[2];
  const searchType = process.argv[3] === 'sale' ? 'sale' : 'rent';
  const shardIndex = process.argv[4] != null ? parseInt(process.argv[4], 10) : 0;
  const shardCount = process.argv[5] != null ? parseInt(process.argv[5], 10) : 1;
  if (!slug) {
    console.error('Usage: node scrape-single-seloger-suburb.js <town-slug> [rent|sale] [shardIndex] [shardCount]');
    process.exit(1);
  }

  const town = SUBURB_TOWNS.find(t => t.slug === slug);
  if (!town) {
    console.error(`Unknown town slug: "${slug}". Known slugs: ${SUBURB_TOWNS.map(t => t.slug).join(', ')}`);
    process.exit(1);
  }

  const shardLabel = shardCount > 1 ? ` (shard ${shardIndex}/${shardCount})` : '';
  console.log(`[${slug}] Scraping ${searchType} in isolation (own process, own session)${shardLabel}...`);
  const start = Date.now();
  const result = await scrapeTown(town, searchType, shardIndex, shardCount);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[${slug}] Done in ${elapsed}s: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''}`);

  const filename = searchType === 'sale'
    ? `output-seloger-${slug}-shard-${shardIndex}-sale.json`
    : `output-seloger-${slug}-shard-${shardIndex}.json`;
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`[${slug}] Wrote ${filename}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

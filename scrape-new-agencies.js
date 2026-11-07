// scrape-new-agencies.js
//
// NEW FILE (2026-11-07). Runs the 13 agencies in new-agencies-config.js
// as their own isolated GitHub Actions job (scrape-new-agencies /
// scrape-new-agencies-sale in scrape-deploy.yml) rather than inside
// scrape-main — scrape-main already carries 25 sources and was bumped to
// a 90-minute timeout after hitting GitHub's limit; these 13 are
// unverified, so keeping them separate means one misbehaving new site
// can't cost the existing sources their day's data.
//
// Usage: node scrape-new-agencies.js [rent|sale] [Source Name]
//   The optional second argument runs a single agency (for debugging).
//
// Output: output-new-agencies.json / output-new-agencies-sale.json, with
// per-agency sourceStatus and a `debug` block per agency showing what the
// auto-scraper discovered — read by merge-and-generate.js.

const fs = require('fs');
const { NEW_AGENCIES } = require('./new-agencies-config');
const { createAgencyScraper } = require('./agency-auto-scraper');

const PER_SOURCE_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_ATTEMPTS = 2; // one retry on error / 0 listings — same idea as combine-sources.js

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  const only = process.argv[3];
  const agencies = only ? NEW_AGENCIES.filter(a => a.source.toLowerCase() === only.toLowerCase()) : NEW_AGENCIES;
  if (only && agencies.length === 0) {
    console.error(`No agency named "${only}". Options: ${NEW_AGENCIES.map(a => a.source).join(', ')}`);
    process.exit(1);
  }

  const listings = [];
  const sourceStatus = [];
  const debug = {};

  for (const agency of agencies) {
    const scrape = createAgencyScraper(agency);
    let result = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      console.log(`\n=== ${agency.source} (${searchType})${attempt > 1 ? ' — retry' : ''} ===`);
      try {
        result = await withTimeout(scrape(searchType), PER_SOURCE_TIMEOUT_MS, agency.source);
      } catch (e) {
        result = { source: agency.source, searchType, listings: [], error: e.message, debug: null };
      }
      // Skipped (rent-only agency, no sale page) is a real answer — don't retry.
      if (result.skipped || (!result.error && result.listings.length > 0)) break;
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 15000 + Math.random() * 5000));
    }

    debug[agency.source] = { ...(result.debug || {}), skipped: result.skipped || null };
    if (result.skipped) {
      console.log(`${agency.source}: skipped (${result.skipped})`);
      continue; // not a failure, and not worth a line in the sheet's Info tab
    }
    const scrapedAt = new Date().toISOString();
    result.listings.forEach(l => { l.scrapedAt = scrapedAt; });
    listings.push(...result.listings);
    sourceStatus.push({ source: agency.source, found: result.listings.length, error: result.error || null, attempts });
  }

  console.log(`\nNew agencies total (${searchType}): ${listings.length}`);
  sourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));

  const out = searchType === 'sale' ? 'output-new-agencies-sale.json' : 'output-new-agencies.json';
  fs.writeFileSync(out, JSON.stringify({ searchType, generatedAt: new Date().toISOString(), totalListings: listings.length, sourceStatus, debug, listings }, null, 2));
  console.log(`\n✅ Wrote ${out}`);
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal error:', err); process.exit(1); });

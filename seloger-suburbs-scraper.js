// seloger-suburbs-scraper.js
//
// Covers 13 western Paris suburb towns — the same corridor Junot itself
// defines as its western coverage area (Neuilly-sur-Seine, Levallois-
// Perret, Boulogne-Billancourt, Rueil-Malmaison, Suresnes, Puteaux,
// Saint-Cloud, Garches, Vaucresson, Marnes-la-Coquette, Ville-d'Avray,
// Le Vésinet, Saint-Germain-en-Laye) — NOT the full ~51 towns used for
// Junot/Barnes, because SeLoger requires an individually verified geo-code
// per town (not a simple slug pattern like Junot/Barnes). Each code below
// was individually confirmed live via search, not guessed or derived from
// a formula — SeLoger's geo-codes are arbitrary IDs, e.g. Paris is
// ad08fr31096 and Neuilly-sur-Seine is ad08fr36623, no discoverable
// relationship between them.
//
// Each town uses the exact same extraction + detail-page-enrichment
// pattern as the main Paris seloger-scraper.js (first page only, no
// pagination attempted — same design decision as Paris, since SeLoger's
// pagination is unsolved for this URL template regardless of location).

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

// Same real bug fix as seloger-arrondissements-scraper.js: hardcoded
// rent-only selector caused every sale job to silently return 0
// listings.
function getListingSelector(searchType) {
  return searchType === 'sale' ? 'a[href*="/annonces/achat/"]' : 'a[href*="/annonces/locations/"]';
}
// Real evidence found live (in seloger-arrondissements-scraper.js):
// raising this to 5 was WRONG - detail-page requests started returning
// tiny ~430-character blocked/challenge pages (vs normal 50,000-90,000
// characters) after the first ~8 requests in a batch. This is
// DataDome's anti-bot system detecting rapid-fire volume. Lowered to 2
// plus added inter-request spacing and retry-on-block logic below.
const DETAIL_FETCH_CONCURRENCY = 2;
// FIXED: was 3, causing nested concurrency (3 towns x 3 detail-fetches =
// up to 9-12 simultaneous pages on ONE browser). Live evidence proved this
// broke real data: Puteaux has 173 active listings (confirmed via direct
// fetch), but the scraper returned 0 — the first 3 towns (matching the old
// concurrency of 3) succeeded, every town after failed silently, strongly
// suggesting the browser degraded under cumulative simultaneous load and
// subsequent pages loaded blank (miscounted as "zero results" rather than
// an error, since a blank page just has no listings to find).
// Sequential town processing caps total simultaneous pages at
// DETAIL_FETCH_CONCURRENCY + 1, not town_concurrency x detail_concurrency.
const TOWN_CONCURRENCY = 1;

// { slug, postalCode, geoCode } — geoCode individually verified live for
// every entry, not derived from a pattern.
const SUBURB_TOWNS = [
  { slug: 'neuilly-sur-seine', postal: '92200', geoCode: 'ad08fr36623', displayName: 'Neuilly-sur-Seine' },
  { slug: 'boulogne-billancourt', postal: '92100', geoCode: 'ad08fr36603', displayName: 'Boulogne-Billancourt' },
  { slug: 'suresnes', postal: '92150', geoCode: 'ad08fr36630', displayName: 'Suresnes' },
  { slug: 'levallois-perret', postal: '92300', geoCode: 'ad08fr36617', displayName: 'Levallois-Perret' },
  { slug: 'rueil-malmaison', postal: '92500', geoCode: 'ad08fr36626', displayName: 'Rueil-Malmaison' },
  { slug: 'puteaux', postal: '92800', geoCode: 'ad08fr36625', displayName: 'Puteaux' },
  { slug: 'saint-cloud', postal: '92210', geoCode: 'ad08fr36627', displayName: 'Saint-Cloud' },
  { slug: 'saint-germain-en-laye', postal: '78100', geoCode: 'ad08fr37122', displayName: 'Saint-Germain-en-Laye' },
  { slug: 'le-vesinet', postal: '78110', geoCode: 'ad08fr32613', displayName: 'Le Vésinet' },
  { slug: 'vaucresson', postal: '92420', geoCode: 'ad08fr36632', displayName: 'Vaucresson' },
  { slug: 'garches', postal: '92380', geoCode: 'ad08fr36613', displayName: 'Garches' },
  { slug: 'marnes-la-coquette', postal: '92430', geoCode: 'ad08fr36619', displayName: 'Marnes-la-Coquette' },
  { slug: 'ville-d-avray', postal: '92410', geoCode: 'ad08fr36633', displayName: "Ville-d'Avray" },
  // 8 towns added later — these show up as clickable chips on the
  // frontend (via other sources' broader suburb coverage, like Junot's
  // 51 towns) but were never actually included in SeLoger's own suburb
  // list until now. Each geoCode individually verified live, same as
  // the original 13 above.
  { slug: 'courbevoie', postal: '92400', geoCode: 'ad08fr36611', displayName: 'Courbevoie' },
  { slug: 'versailles', postal: '78000', geoCode: 'ad08fr32611', displayName: 'Versailles' },
  { slug: 'issy-les-moulineaux', postal: '92130', geoCode: 'ad08fr36616', displayName: 'Issy-les-Moulineaux' },
  { slug: 'colombes', postal: '92700', geoCode: 'ad08fr36610', displayName: 'Colombes' },
  { slug: 'nanterre', postal: '92000', geoCode: 'ad08fr36622', displayName: 'Nanterre' },
  { slug: 'chatou', postal: '78400', geoCode: 'ad08fr32414', displayName: 'Chatou' },
  { slug: 'croissy-sur-seine', postal: '78290', geoCode: 'ad08fr32429', displayName: 'Croissy-sur-Seine' },
  { slug: 'la-celle-saint-cloud', postal: '78170', geoCode: 'ad08fr32408', displayName: 'La Celle-Saint-Cloud' }
];

async function getBrowser() {
  // Switched to puppeteer-extra + stealth plugin after real evidence of
  // SeLoger's anti-bot system (DataDome) partially blocking even isolated,
  // separately-run scraping jobs. This patches common headless-Chrome
  // automation tells (navigator.webdriver, missing plugins, etc). Being
  // realistic about this: published 2026 research shows DataDome
  // specifically has detection methods for this exact plugin, and
  // increasingly targets network/TLS-level fingerprints a JS-level patch
  // can't reach at all — this is worth trying (free, addresses a real gap
  // we hadn't touched), not a guaranteed fix.
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  return withTimeout(
    puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
    }),
    30000,
    'Launching local Chrome via Puppeteer (SeLoger suburbs)'
  );
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

// Extracts the page's own stated listing count from its title/heading —
// e.g. "2 annonces appartements à louer Marnes-la-Coquette 92430" or
// "173 annonces Appartements à louer Puteaux 92800". This is used as a
// self-correcting cap: real evidence showed a sparse town (Marnes-la-
// Coquette, genuinely 2 listings) had its results padded to 32 by
// SeLoger's own "Plus d'annonces à proximité" (more listings nearby)
// filler section, which shows suggested listings from NEIGHBORING towns
// directly on the same page when a search has few genuine matches. Our
// selector can't distinguish "genuine local match" from "nearby filler"
// by DOM structure alone, but the page's own stated count gives ground
// truth — capping to it (keeping the first N in DOM order, since filler
// content consistently appears after genuine results in every case
// checked) removes the contamination without needing per-town DOM work.
function extractListings(searchType) {
  const results = [];
  const seen = new Set();
  const linkSelector = searchType === 'sale' ? 'a[href*="/annonces/achat/"]' : 'a[href*="/annonces/locations/"]';
  const links = Array.from(document.querySelectorAll(linkSelector));

  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);

    let container = link;
    let text = '';
    for (let i = 0; i < 8; i++) {
      container = container.parentElement;
      if (!container) break;
      text = container.innerText || '';
      if (text.includes('€')) break;
    }

    if (text.includes('€')) {
      results.push({ url: href.split('?')[0], rawText: text.slice(0, 500) });
    }
  }

  // FIXED — same real Puppeteer serialization bug found across all 3
  // SeLoger scrapers: page.evaluate(extractListings) only sends THIS
  // function's own source into the browser, not a separate
  // extractStatedCount() function it referenced. Inlined here.
  const titleText = document.title + ' ' + (document.querySelector('h1') ? document.querySelector('h1').innerText : '');
  const countMatch = titleText.match(/(\d[\d\s]*)\s*annonces/i);
  const statedCount = countMatch ? parseInt(countMatch[1].replace(/\s/g, ''), 10) : null;

  if (statedCount !== null && statedCount < results.length) {
    return results.slice(0, statedCount);
  }
  return results;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchListingDetails(browser, url, isRetry = false) {
  let page;
  try {
    // Small randomized delay before each request - spaces out requests
    // to reduce the chance of triggering DataDome's rate-based blocking.
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(20000);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const bodyText = await page.evaluate(() => {
      const visible = document.body.innerText || '';
      const all = document.body.textContent || '';
      const spaced = all.replace(/([a-z])([A-Z])/g, '$1 $2');
      return visible + ' ' + spaced;
    });

    await page.close();

    // Real bug found live: checking only bodyText.length missed a whole
    // class of failures - a genuine 403 block returns instantly with
    // empty content, and extractDetailFeatures('') on empty text
    // returns elevator:false/balcony:false (their real defaults) rather
    // than null, so the old "all fields null" check never caught this.
    const status = response ? response.status() : null;
    const isBlocked = status === 403 || status === 429 || bodyText.length < 2000;
    if (isBlocked && !isRetry) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      return fetchListingDetails(browser, url, true);
    }

    const result = extractDetailFeatures(bodyText);
    result._wasBlocked = isBlocked;
    return result;
  } catch (error) {
    console.log(`[SeLoger-Suburbs] Detail fetch failed for ${url}: ${error.message}`);
    if (page) { try { await page.close(); } catch (e) {} }
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null, _wasBlocked: true };
  }
}

async function enrichWithDetails(listings, label) {
  if (listings.length === 0) return listings;
  const freshBrowser = await getBrowser();
  try {
    const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, (listing) =>
      fetchListingDetails(freshBrowser, listing.url)
    );
    const blocked = details.filter(d => d._wasBlocked).length;
    console.log(`[SeLoger-${label}] Detail enrichment: ${listings.length - blocked}/${listings.length} succeeded, ${blocked} blocked/failed`);
    return listings.map((listing, i) => {
      const d = details[i];
      const bathrooms = listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail;
      let bedroomsFromDetail = d.bedroomsFromDetail;
      if (bedroomsFromDetail != null && listing.rooms != null && bedroomsFromDetail > listing.rooms) {
        bedroomsFromDetail = null;
      }
      const bedrooms = listing.bedrooms != null ? listing.bedrooms : bedroomsFromDetail;
      return { ...listing, elevator: d.elevator, balcony: d.balcony, furnished: d.furnished, bathrooms, bedrooms };
    });
  } finally {
    await freshBrowser.close();
  }
}

// FIXED — sequential-only processing (removing town-level concurrency)
// did NOT fix the earlier bug: live evidence showed even fully sequential
// runs still failed after town #2-3 (Suresnes, which worked before, now
// also failed). This points to a different cause than nested concurrency:
// ONE long-lived browser instance accumulating enough page-opens across
// MANY towns (each town does its own listing page + ~20-30 detail-page
// visits) eventually degrades — by town 3 we'd already done 100+ total
// page opens on a single browser. Launching a FRESH browser per town
// costs a little startup overhead (~1-2s each) but avoids any cumulative
// degradation entirely, since each town starts with a clean browser.
// shardIndex/shardCount: same fix applied to the arrondissement scraper —
// real evidence found live (2026-07-21) that some suburbs (e.g.
// Boulogne-Billancourt: 1522 sale listings) need up to ~70 minutes just
// for detail-page enrichment, blowing past even a generously bumped job
// timeout. Every shard does its own full pagination but only enriches
// the fraction of listings where `index % shardCount === shardIndex`.
// Defaults (0, 1) preserve old single-job behavior for any caller that
// doesn't pass these.
async function scrapeTown(town, searchType, shardIndex = 0, shardCount = 1) {
  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(20000);

    // Real pagination confirmed live via ?LISTING-LISTpg=N (see
    // seloger-arrondissements-scraper.js for the full research note). No
    // hardcoded page/result cap — same reasoning as the arrondissement
    // scraper: a fixed cap silently drops real listings in denser towns.
    // Loop runs until a page yields zero new listings.
    const allParsed = [];
    const seenUrls = new Set();

    for (let pageNum = 1; ; pageNum++) {
      const distributionType = searchType === 'sale' ? 'Buy' : 'Rent';
      const url = `https://www.seloger.com/classified-search?distributionTypes=${distributionType}&estateTypes=Apartment&locations=${town.geoCode.toUpperCase()}&page=${pageNum}`;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      try {
        await page.waitForSelector(getListingSelector(searchType), { timeout: 10000 });
      } catch (e) {
        // Genuinely zero/out-of-pages for this town — expected occasionally.
        break;
      }

      const raw = await page.evaluate(extractListings, searchType);
      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'SeLoger';
        listing.searchType = searchType;
        listing.isExactListing = true;
        // Override the parsed address with the KNOWN town name — we
        // already know exactly which town this is (it's the URL we
        // chose), so this is both more reliable and perfectly
        // consistent than trying to re-derive it from noisy card text,
        // which was shown to sometimes grab a floor number ("1 / 12"),
        // postal code fragment, or agency name instead of a real
        // location.
        listing.address = town.displayName;
        allParsed.push(listing);
        newCount++;
      }

      console.log(`[SeLoger-${town.slug}] Page ${pageNum}: ${newCount} new listing(s), ${allParsed.length} total so far`);

      if (newCount === 0) break;
    }

    const valid = allParsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);

    // Shard AFTER full pagination completes — see the arrondissement
    // scraper's identical comment for why (every shard sees the full
    // listing set and independently picks its own slice).
    const shard = shardCount > 1 ? valid.filter((_, i) => i % shardCount === shardIndex) : valid;
    if (shardCount > 1) {
      console.log(`[SeLoger-${town.slug}] Shard ${shardIndex}/${shardCount}: enriching ${shard.length}/${valid.length} listings`);
    }

    // Close the pagination browser/page before enrichment, which now
    // launches a genuinely fresh browser of its own.
    await page.close();
    await browser.close();
    browser = null;
    page = null;

    const enriched = await enrichWithDetails(shard, town.slug);
    return { slug: town.slug, listings: enriched, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { slug: town.slug, listings: [], error: error.message };
  }
}

async function scrapeSeLogerSuburbs(searchType = 'rent') {
  try {
    console.log(`[SeLoger-Suburbs] Scraping ${SUBURB_TOWNS.length} suburb towns...`);

    let completed = 0;
    const start = Date.now();
    // Sequential (TOWN_CONCURRENCY=1) since each town now gets its own
    // fresh browser — no benefit to overlapping them, and doing so would
    // reintroduce the original nested-resource-usage risk.
    //
    // NEW: deliberate delay between towns. Live evidence ruled out browser
    // reuse as the cause (fresh browser per town still failed identically
    // after town #2), which points instead to IP-based rate-limiting —
    // consistent with SeLoger's confirmed DataDome usage and prior research
    // noting it "can trigger blocks after a few successful requests." If
    // this is frequency-based rather than a hard per-run cap, spacing
    // requests out should let more towns through. This is a genuine test,
    // not a guaranteed fix.
    const DELAY_BETWEEN_TOWNS_MS = 15000;
    let isFirst = true;
    const results = await mapWithConcurrency(SUBURB_TOWNS, TOWN_CONCURRENCY, async (town) => {
      if (!isFirst) {
        console.log(`[SeLoger-Suburbs] Waiting ${DELAY_BETWEEN_TOWNS_MS / 1000}s before next town (testing rate-limit theory)...`);
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_TOWNS_MS));
      }
      isFirst = false;
      const result = await scrapeTown(town, searchType);
      completed++;
      console.log(`[SeLoger-Suburbs] Progress: ${completed}/${SUBURB_TOWNS.length} (${town.slug}: ${result.listings.length} listings${result.error ? ', ERROR: ' + result.error : ''})`);
      return result;
    });

    const allListings = [];
    const failedSlugs = [];
    let zeroResultCount = 0;

    for (const r of results) {
      if (r.error) { failedSlugs.push(`${r.slug} (${r.error})`); continue; }
      if (r.listings.length === 0) { zeroResultCount++; continue; }
      allListings.push(...r.listings);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[SeLoger-Suburbs] Total listings: ${allListings.length} in ${elapsed}s`);
    console.log(`[SeLoger-Suburbs] Zero-result towns: ${zeroResultCount}/${SUBURB_TOWNS.length}`);
    if (failedSlugs.length > 0) console.log(`[SeLoger-Suburbs] Failed towns: ${failedSlugs.join(', ')}`);

    return {
      source: 'SeLoger',
      searchType,
      listings: allListings,
      error: null,
      diagnostics: { zeroResultCount, failedSlugs }
    };

  } catch (error) {
    console.error(`[SeLoger-Suburbs] Fatal error: ${error.message}`);
    return { source: 'SeLoger', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeSeLogerSuburbs, SUBURB_TOWNS, scrapeTown };

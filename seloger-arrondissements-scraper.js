// seloger-arrondissements-scraper.js
//
// Covers all 20 Paris arrondissements as separate isolated locations —
// same architecture as seloger-suburbs-scraper.js (each gets its own
// browser/session, meant to run as its own GitHub Actions matrix job).
//
// Goal: the all-Paris search (seloger-scraper.js) only returns ~30
// listings (one page load, and Paris' pagination is unsolved — see that
// file's own notes on 3 failed pagination strategies). Treating each
// arrondissement as its own "location" search sidesteps needing
// pagination at all, the same trick that fixed the suburb coverage.
//
// GEO-CODES: SeLoger's arrondissement geo-codes follow a confirmed
// pattern — ad09fr(25 + arrondissement number). Verified live for 3
// arrondissements (7th=ad09fr32, 15th=ad09fr40, 16th=ad09fr41, all
// matching the formula exactly). The other 17 are constructed from this
// formula, NOT individually verified — if the pattern breaks for a
// specific arrondissement, that job will show 0 results (see
// scrapeArrondissement's zero-result handling) rather than erroring, so
// a wrong code fails visibly, not silently as wrong data.

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const PARIS_ARRONDISSEMENTS = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1;
  const postal = `750${n.toString().padStart(2, '0')}`;
  const geoCode = `ad09fr${25 + n}`;
  // French ordinal convention: 1er (premier), not "1eme" — every other
  // arrondissement (2nd-20th) correctly uses "eme" per the 3 confirmed
  // real examples (7eme, 15eme, 16eme).
  const ordinal = n === 1 ? '1er' : `${n}eme`;
  // displayName matches the SAME "Paris Nème" format Barnes and SeLoger's
  // main Paris scraper already use — cross-source consistency, per direct
  // request, so sorting/grouping by address works the same way regardless
  // of which agency a listing came from.
  const displayName = n === 1 ? 'Paris 1er' : `Paris ${n}ème`;
  return { arrondissement: n, slug: `paris-${ordinal}-arrondissement-${postal}`, postal, geoCode, displayName };
});

// Real bug found live: this was hardcoded to /annonces/locations/ (rent
// only), causing every sale job to silently return 0 listings — the
// selector never matched anything on a buy page (which uses
// /annonces/achat/ instead), so waitForSelector always timed out and
// the loop broke immediately, looking like "genuinely zero results"
// rather than a wrong selector. Confirmed live: buy listing links use
// /annonces/achat/appartement/... (e.g. .../ecole-militaire/274282375.htm).
function getListingSelector(searchType) {
  return searchType === 'sale' ? 'a[href*="/annonces/achat/"]' : 'a[href*="/annonces/locations/"]';
}
// Real evidence found live: raising this to 5 was WRONG - detail-page
// requests started returning tiny ~430-character blocked/challenge
// pages (vs normal 50,000-90,000 characters) starting around the 9th
// request in a batch of 463. This is DataDome's anti-bot system
// detecting the rapid-fire volume and serving degraded content instead
// of real pages. Lowered to 2 (below the original 3) plus added
// inter-request spacing and retry-on-block logic below, rather than
// just reverting the number alone.
const DETAIL_FETCH_CONCURRENCY = 2;

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
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

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

  // Same contamination-cap fix as seloger-suburbs-scraper.js — caps to
  // the page's own stated count if we somehow picked up more (e.g. a
  // "nearby suggestions" filler section).
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
    // to look less like an automated batch, reducing the chance of
    // triggering DataDome's rate-based blocking.
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
    // class of failures. A genuine 403 block returns instantly with
    // empty content, and extractDetailFeatures('') on empty text
    // returns elevator:false/balcony:false (their real defaults) rather
    // than null - so the old "all fields null = blocked" check never
    // caught this, silently counting real blocks as "successful, just
    // nothing to report". Checking the actual HTTP status directly
    // catches this properly regardless of what the resulting text looks
    // like.
    const status = response ? response.status() : null;
    const isBlocked = status === 403 || status === 429 || bodyText.length < 2000;
    if (isBlocked && !isRetry) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      return fetchListingDetails(browser, url, true);
    }

    const result = extractDetailFeatures(bodyText);
    result._wasBlocked = isBlocked; // still blocked even after the retry, or this IS the retry and it's still blocked
    return result;
  } catch (error) {
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

// Scrapes ONE arrondissement in complete isolation (own browser, meant to
// run as its own GitHub Actions job) — same pattern proven for suburbs.
//
// shardIndex/shardCount: real evidence found live (2026-07-21) that
// removing the page/result cap wasn't enough on its own — the busiest
// arrondissements (15th: 2075 sale listings) need up to ~95 minutes just
// for detail-page enrichment at the safe anti-bot concurrency, blowing
// past even a generously bumped job timeout. Every shard runs its OWN
// full pagination pass (cheap, ~1-3 min) but only enriches the fraction
// of listings where `index % shardCount === shardIndex` — splitting the
// expensive part (enrichment) across parallel isolated jobs instead of
// racing one job against an ever-bigger clock. Defaults (0, 1) preserve
// old single-job behavior for any caller that doesn't pass these.
async function scrapeArrondissement(arr, searchType, shardIndex = 0, shardCount = 1) {
  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(20000);

    // Real pagination confirmed via live testing (found by clicking the
    // actual page-2 button in the UI and observing the URL it produces —
    // every URL-parameter-guessing attempt before this failed silently).
    // The real endpoint is /classified-search with a 'page' parameter
    // and the geoCode UPPERCASED — verified across 5 pages returning 144
    // genuinely unique listings (28-30 new per page), not the same
    // content repeated.
    //
    // No hardcoded page/result cap — real evidence found live: the 15th,
    // 16th, and 17th arrondissements alone have 784/706/566 listings,
    // well past the 450 this used to cap at, silently dropping ~700 real
    // listings across just those three. Loop now runs until a page
    // yields zero new listings (genuinely out of pages) — see the job
    // timeout bump in scrape-deploy.yml, which now gives enough headroom
    // for the busiest arrondissements to finish enrichment too.
    const allParsed = [];
    const seenUrls = new Set();

    for (let pageNum = 1; ; pageNum++) {
      const distributionType = searchType === 'sale' ? 'Buy' : 'Rent';
      const url = `https://www.seloger.com/classified-search?distributionTypes=${distributionType}&estateTypes=Apartment&locations=${arr.geoCode.toUpperCase()}&page=${pageNum}`;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      try {
        await page.waitForSelector(getListingSelector(searchType), { timeout: 10000 });
      } catch (e) {
        // No listings on this page — either genuinely out of pages, or
        // (for page 1 of the 17 unverified arrondissements) a wrong
        // geo-code. Either way, stop here rather than guess further.
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
        // Override with the known arrondissement — we already know
        // exactly which one this is, more reliable than re-deriving
        // from noisy text.
        listing.address = arr.displayName;
        allParsed.push(listing);
        newCount++;
      }

      console.log(`[SeLoger-${arr.slug}] Page ${pageNum}: ${newCount} new listing(s), ${allParsed.length} total so far`);

      if (newCount === 0) break; // genuinely reached the end
    }

    const valid = allParsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);

    // Shard AFTER full pagination completes — every shard sees the same
    // complete listing set and independently picks its own slice, so no
    // shard needs to know what any other found. Index-modulo keeps each
    // shard's slice roughly even regardless of shardCount.
    const shard = shardCount > 1 ? valid.filter((_, i) => i % shardCount === shardIndex) : valid;
    if (shardCount > 1) {
      console.log(`[SeLoger-${arr.slug}] Shard ${shardIndex}/${shardCount}: enriching ${shard.length}/${valid.length} listings`);
    }

    // Close the pagination browser/page before enrichment, which now
    // launches a genuinely fresh browser of its own (see the
    // EXPERIMENTAL note in enrichWithDetails above).
    await page.close();
    await browser.close();
    browser = null;
    page = null;

    const enriched = await enrichWithDetails(shard, arr.slug);
    return { arrondissement: arr.arrondissement, listings: enriched, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { arrondissement: arr.arrondissement, listings: [], error: error.message };
  }
}

module.exports = { scrapeArrondissement, PARIS_ARRONDISSEMENTS };

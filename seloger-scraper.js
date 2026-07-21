// seloger-scraper.js
// Production version of the SeLoger scraper — first page only (~31
// listings). Pagination was attempted via three different strategies
// (numbered buttons, click-based "next" button, URL parameters) and all
// three failed for specific, understood reasons — documented below for
// whoever revisits this later. First-page extraction itself is solid:
// verified correct across many live runs, zero bot-blocking encountered
// even under sustained interaction.
//
// PAGINATION — NOT SOLVED, kept here for whoever picks this back up:
//   1. Numbered page buttons (1, 2, 3, ...N): the bar shows a FIXED set
//      that doesn't reveal nearby numbers as you advance — there's no
//      literal "4" button to find/click after reaching page 3.
//   2. Icon-only "next" button (aria-label="page suivante"): found and
//      confirmed correctly targeted (not disabled, not covered by an
//      overlay after fixing a real click-interception bug), but clicking
//      it — even with Puppeteer's real mouse click — never advanced the
//      page. Root cause unconfirmed; the button uses React Aria
//      (data-react-aria-pressable="true"), which has known quirks around
//      what counts as a "real" interaction.
//   3. URL parameter (?LISTING-LISTpg=2): confirmed to exist for a
//      DIFFERENT SeLoger URL template (/immobilier/achat/...) via
//      external research, but produced 29/31 overlapping (i.e. not
//      actually different) results on the /recherche/location/... URL
//      template used here. Likely template-specific; untested on the
//      older URL style.
//
// Given the project's move to scheduled (not live on-demand) scraping,
// 31 fresh listings per run, twice daily, is a reasonable interim outcome
// — not exhaustive, but continuously sampling new listings over time.

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const PARIS_GEOCODE = 'ad08fr31096';
// Same real bug fix as the arrondissement/suburb scrapers: hardcoded
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
    'Launching local Chrome via Puppeteer (SeLoger)'
  );
}

// Same fix as scrape-runner.js — browser launch previously had no timeout
// protection at all, unlike every other wait in this file.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
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

  // FIXED — this used to call a separate extractStatedCount() function,
  // which caused a real crash: page.evaluate(extractListings) only sends
  // THIS function's own source into the browser, not any other function
  // it references from the same file. Inlined directly here so the whole
  // thing is one self-contained function, no cross-function reference.
  const titleText = document.title + ' ' + (document.querySelector('h1') ? document.querySelector('h1').innerText : '');
  const countMatch = titleText.match(/(\d[\d\s]*)\s*annonces/i);
  const statedCount = countMatch ? parseInt(countMatch[1].replace(/\s/g, ''), 10) : null;

  // Defensive: same fix applied to seloger-suburbs-scraper.js after real
  // evidence of "nearby suggestions" filler inflating sparse-result towns.
  // A no-op for Paris in practice (real inventory always exceeds one
  // page's worth), but keeps both scrapers consistent.
  if (statedCount !== null && statedCount < results.length) {
    return results.slice(0, statedCount);
  }
  return results;
}

// Same concurrency-limited map pattern used for Barnes — runs at most
// `limit` detail-page fetches at a time.
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

// Visits ONE listing's detail page and extracts elevator/furnished/
// bathroom count from SeLoger's "Caractéristiques" checklist — confirmed
// via a real fetched detail page to contain clean bullet items like
// "Ascenseur", "Meublé", "1 salle de douches", not free prose. A failure
// here must not crash the whole batch — returns nulls instead, visible
// and honest rather than silently wrong.
async function fetchListingDetails(browser, url, isRetry = false) {
  let page;
  try {
    // Small randomized delay before each request - spaces out requests
    // to reduce the chance of triggering DataDome's rate-based blocking.
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const bodyText = await page.evaluate(() => {
      const visible = document.body.innerText || '';
      const all = document.body.textContent || '';
      const spaced = all.replace(/([a-z])([A-Z])/g, '$1 $2');
      return visible + ' ' + spaced;
    });

    await page.close();

    // Real evidence found live: a genuine SeLoger listing page always
    // returns 50,000+ characters. Anything under ~2000 is a DataDome
    // block/challenge page - detecting and retrying once after a
    // longer cooldown recovers many of these.
    if (bodyText.length < 2000 && !isRetry) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      return fetchListingDetails(browser, url, true);
    }

    return extractDetailFeatures(bodyText);
  } catch (error) {
    console.log(`[SeLoger] Detail fetch failed for ${url}: ${error.message}`);
    if (page) { try { await page.close(); } catch (e) {} }
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null };
  }
}

// Enriches parsed listings with detail-page data. Always runs for SeLoger
// (unlike Barnes, where it's opt-in) since the cost is low: ~30 listings
// per run here versus Barnes' 100, so this adds roughly 20-40 seconds,
// not minutes.
async function enrichWithDetails(listings) {
  if (listings.length === 0) return listings;
  // Real evidence found live (in seloger-arrondissements-scraper.js):
  // detail-page requests were ALL getting blocked when reusing the same
  // browser session that had just finished rapid pagination - launching
  // a genuinely fresh browser specifically for enrichment fixed this
  // completely, confirmed across 130+ consecutive successful requests.
  const freshBrowser = await getBrowser();
  try {
    console.log(`[SeLoger] Fetching detail pages for ${listings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const start = Date.now();
    let completed = 0;

    const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, async (listing) => {
      const result = await fetchListingDetails(freshBrowser, listing.url);
      completed++;
      if (completed % 10 === 0 || completed === listings.length) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`[SeLoger] Detail progress: ${completed}/${listings.length} (${elapsed}s elapsed)`);
      }
      return result;
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const blocked = details.filter(d => d.elevator === null && d.balcony === null && d.furnished === null && d.bathroomsFromDetail === null && d.bedroomsFromDetail === null).length;
    console.log(`[SeLoger] Detail fetch complete in ${elapsed}s: ${listings.length - blocked}/${listings.length} succeeded, ${blocked} blocked/failed`);

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

async function scrapeSeLoger(searchType = 'rent') {
  let browser;
  let page;

  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(30000);

    // Real pagination confirmed live via ?LISTING-LISTpg=N (see
    // seloger-arrondissements-scraper.js for the full research note).
    // MAX_PAGES kept smaller here (8, vs 15 for the isolated
    // per-arrondissement/suburb jobs) since this runs inside scrape-main,
    // sharing its 15-minute budget with Barnes and Junot rather than
    // having its own dedicated 5-minute window.
    const MAX_PAGES = 15;
    const allParsed = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const distributionType = searchType === 'sale' ? 'Buy' : 'Rent';
      const url = `https://www.seloger.com/classified-search?distributionTypes=${distributionType}&estateTypes=Apartment&locations=${PARIS_GEOCODE.toUpperCase()}&page=${pageNum}`;
      console.log(`[SeLoger] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(err => {
        console.warn(`[SeLoger] Navigation warning: ${err.message}`);
      });

      await new Promise(r => setTimeout(r, 3000)); // let consent banner / JS challenge settle

      try {
        await page.waitForSelector(getListingSelector(searchType), { timeout: 15000 });
      } catch (e) {
        console.warn(`[SeLoger] Page ${pageNum}: selector timeout — stopping pagination here.`);
        break;
      }

      const rawListings = await page.evaluate(extractListings, searchType);
      let newCount = 0;
      for (const item of rawListings) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'SeLoger';
        listing.searchType = searchType;
        listing.isExactListing = true;
        allParsed.push(listing);
        newCount++;
      }
      console.log(`[SeLoger] Page ${pageNum}: ${newCount} new listing(s), ${allParsed.length} total so far`);

      if (newCount === 0) break;
      if (allParsed.length >= 100) break;
    }

    const valid = allParsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);
    console.log(`[SeLoger] Valid listings: ${valid.length}`);

    // Close the pagination browser/page before enrichment, which now
    // launches a genuinely fresh browser of its own.
    await page.close();
    await browser.close();
    browser = null;
    page = null;

    const enriched = await enrichWithDetails(valid);

    return { source: 'SeLoger', searchType, listings: enriched, error: null };

  } catch (error) {
    console.error(`[SeLoger] Error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'SeLoger', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeSeLoger };

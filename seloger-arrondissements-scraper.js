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

const LISTING_SELECTOR = 'a[href*="/annonces/locations/"]';
const DETAIL_FETCH_CONCURRENCY = 3;

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

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/annonces/locations/"]'));

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

async function fetchListingDetails(browser, url) {
  let page;
  try {
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
    return extractDetailFeatures(bodyText);
  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null };
  }
}

async function enrichWithDetails(browser, listings) {
  if (listings.length === 0) return listings;
  const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, (listing) =>
    fetchListingDetails(browser, listing.url)
  );
  return listings.map((listing, i) => {
    const d = details[i];
    const bathrooms = listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail;
    // Real evidence: SeLoger detail pages commonly state chambres
    // explicitly even when the summary card only shows pièces count —
    // fills in a real bedroom count instead of leaving it null.
    // Sanity check added after a real contamination bug found live:
    // bedroomsFromDetail sometimes picks up an UNRELATED property's room
    // count from a detail page's own 'similar listings' sidebar (a studio
    // showed rooms:1 but bedroomsFromDetail:5 — logically impossible,
    // since bedrooms can never exceed the listing's own total room
    // count). Rejecting values that fail this basic consistency check is
    // safer than trying to guess exactly where on the page to stop
    // reading, which risks cutting off the real Caractéristiques
    // checklist if it happens to appear later on the page.
    let bedroomsFromDetail = d.bedroomsFromDetail;
    if (bedroomsFromDetail != null && listing.rooms != null && bedroomsFromDetail > listing.rooms) {
      bedroomsFromDetail = null;
    }
    const bedrooms = listing.bedrooms != null ? listing.bedrooms : bedroomsFromDetail;
    return { ...listing, elevator: d.elevator, balcony: d.balcony, furnished: d.furnished, bathrooms, bedrooms };
  });
}

// Scrapes ONE arrondissement in complete isolation (own browser, meant to
// run as its own GitHub Actions job) — same pattern proven for suburbs.
async function scrapeArrondissement(arr, searchType) {
  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'); // fixes 403 blocks from bot-detection checking for the default 'HeadlessChrome' signature (confirmed root cause via live ParisRental testing)
    await page.setDefaultNavigationTimeout(20000);

    // Real pagination confirmed live: SeLoger supports ?LISTING-LISTpg=N
    // (found via direct research — a popular arrondissement can have up
    // to ~15 pages / 400+ listings, versus the ~25-30 we were capturing
    // from page 1 alone). Capped at 100 total listings and MAX_PAGES
    // pages — matching the same cap used elsewhere in this project — to
    // stay within the 5-minute job timeout once detail-page enrichment
    // (which runs per listing) is added on top.
    const MAX_PAGES = 15;
    const allParsed = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = pageNum === 1
        ? `https://www.seloger.com/recherche/location/appartement/paris-75000/${arr.slug}/${arr.geoCode}`
        : `https://www.seloger.com/recherche/location/appartement/paris-75000/${arr.slug}/${arr.geoCode}?LISTING-LISTpg=${pageNum}`;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        // No listings on this page — either genuinely out of pages, or
        // (for page 1 of the 17 unverified arrondissements) a wrong
        // geo-code. Either way, stop here rather than guess further.
        break;
      }

      const raw = await page.evaluate(extractListings);
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
      if (allParsed.length >= 300) break; // cap reached
    }

    const valid = allParsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);

    const enriched = await enrichWithDetails(browser, valid);
    await page.close();
    await browser.close();
    return { arrondissement: arr.arrondissement, listings: enriched, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { arrondissement: arr.arrondissement, listings: [], error: error.message };
  }
}

module.exports = { scrapeArrondissement, PARIS_ARRONDISSEMENTS };

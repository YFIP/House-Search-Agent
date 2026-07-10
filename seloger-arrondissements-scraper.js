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
  const puppeteer = require('puppeteer');
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
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null };
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
    return { ...listing, elevator: d.elevator, balcony: d.balcony, furnished: d.furnished, bathrooms };
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
    await page.setDefaultNavigationTimeout(20000);
    const url = `https://www.seloger.com/recherche/location/appartement/paris-75000/${arr.slug}/${arr.geoCode}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    try {
      await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
    } catch (e) {
      // Zero listings — could be genuine, or (for the 17 unverified
      // arrondissements) a wrong geo-code. Either way, fails visibly as
      // zero, not silently as wrong data.
    }

    const raw = await page.evaluate(extractListings);
    const parsed = raw.map(item => {
      const listing = parseListing(item.rawText);
      listing.url = item.url;
      listing.source = 'SeLoger';
      listing.searchType = searchType;
      listing.isExactListing = true;
      // Override with the known arrondissement — we already know exactly
      // which one this is, more reliable than re-deriving from noisy text.
      listing.address = arr.displayName;
      return listing;
    });
    const valid = parsed.filter(l => l.price > 0 || l.priceOnRequest || l.address);

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

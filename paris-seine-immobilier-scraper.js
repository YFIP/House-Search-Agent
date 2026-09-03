// paris-seine-immobilier-scraper.js
//
// NEW FILE. Paris Seine Immobilier runs on the Orisha/Poliris real-estate
// platform (footer confirms "realestate.orisha.com") — same underlying
// template as Patrimoine Ouest Parisien and AFR Immobilier (see those
// files), just a different agency's data on it.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.paris-seine-immobilier.com/annonces/transaction/Location.html
//   - Listing link pattern: a[href*="/fiches/"] — e.g.
//     /fiches/3-32-35_61330417/bac-superbe-appartement-de-standing....html
//   - Price format: "Loyer 4 500 €/mois" (rent) — matches parse-listing.js's
//     rent-specific "€/mois" regex directly.
//   - Pagination: NOT verified for this specific listing URL (only saw it
//     via a ville_bien search result using a different page-N.html scheme).
//     Assuming the same `_____N` URL-segment pattern confirmed live on
//     Patrimoine Ouest Parisien/AFR Immobilier (same platform, same
//     template) — if that assumption is wrong, this safely degrades to
//     page-1-only rather than erroring, since we stop as soon as a
//     constructed page URL returns zero new listings.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.paris-seine-immobilier.com/annonces/transaction/Location.html';
const SALE_URL = 'https://www.paris-seine-immobilier.com/annonces/transaction/Vente.html';
const LISTING_SELECTOR = 'a[href*="/fiches/"]';
const MAX_PAGES = 15; // safety cap; unverified pagination pattern (see header note)
const DETAIL_FETCH_CONCURRENCY = 2;

// BUG FIX (2026-09-02): switched to puppeteer-extra + stealth plugin —
// this was applied to Patrimoine Ouest Parisien and AFR Immobilier
// (same Orisha platform) but never to this file, an oversight. Worth
// noting: those two later regressed from working (59/31 listings) back
// to 0 with ZERO code changes in between — meaning something changed
// on the site/platform side, not in our code. This fix may or may not
// hold up for the same reason; it's not a guarantee against a platform
// that's actively adapting its defenses.
async function getBrowser() {
  const puppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

function pageUrl(baseUrl, pageNum) {
  if (pageNum === 1) return baseUrl;
  // Orisha platform's observed pattern: insert "_____N" before the
  // trailing filename, e.g. .../transaction/Location.html ->
  // .../transaction_____2/Location.html
  return baseUrl.replace(/\/([^/]+)\.html$/, `_____${pageNum}/$1.html`);
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
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    await page.close();
    if (bodyText.length < 500 && !isRetry) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      return fetchListingDetails(browser, url, true);
    }
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
    return {
      ...listing,
      elevator: mergeFeature(d.elevator, listing.elevator),
      balcony: mergeFeature(d.balcony, listing.balcony),
      furnished: mergeFeature(d.furnished, listing.furnished),
      bathrooms: listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail,
      bedrooms: listing.bedrooms != null ? listing.bedrooms : d.bedroomsFromDetail
    };
  });
}

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);
    let container = link.closest('div') || link.parentElement;
    for (let i = 0; i < 5 && container && container.innerText.length < 30; i++) {
      container = container.parentElement;
    }
    const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 500) });
  }
  return results;
}

async function scrapeParisSeineImmobilier(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageUrl(baseUrl, pageNum);

      console.log(`[Paris Seine Immobilier] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Paris Seine Immobilier] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Paris Seine Immobilier] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Paris Seine Immobilier';
        listing.searchType = searchType;
        listing.isExactListing = true;
        const details = extractDetailFeatures(item.rawText);
        if (listing.elevator == null) listing.elevator = details.elevator;
        if (listing.balcony == null) listing.balcony = details.balcony;
        if (listing.furnished == null) listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
        allListings.push(listing);
        newCount++;
      }
      await page.close();

      if (newCount === 0) {
        console.log(`[Paris Seine Immobilier] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Paris Seine Immobilier] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Paris Seine Immobilier] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Paris Seine Immobilier', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Paris Seine Immobilier] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Paris Seine Immobilier', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeParisSeineImmobilier };

// afr-immobilier-scraper.js
//
// NEW FILE. AFR Immobilier runs on the Orisha/Poliris real-estate
// platform (footer confirms "realestate.orisha.com") — same underlying
// template as Paris Seine Immobilier and Patrimoine Ouest Parisien (see
// those files), just a different agency's data on it.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.afr-immobilier.com/annonces/transaction/Location.html
//     — 30 listings, confirmed live (211 sale).
//   - Listing link pattern: a[href*="/fiches/"] — e.g.
//     /fiches/3-32-35_61443718/2-3-p-meuble-chatou-1-parking.html
//   - Price format: "Loyer 1 250 €/mois" (rent) — matches
//     parse-listing.js's rent-specific "€/mois" regex directly.
//   - Pagination: VERIFIED live — real page-2/page-3 links seen at the
//     bottom of the results, using the pattern
//     .../annonces/transaction_____2/location.html (page number inserted
//     before the trailing filename).

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.afr-immobilier.com/annonces/transaction/Location.html';
const SALE_URL = 'https://www.afr-immobilier.com/annonces/transaction/Vente.html';
const LISTING_SELECTOR = 'a[href*="/fiches/"]';
const MAX_PAGES = 15; // safety cap, well above the ~2-3 pages actually observed
const DETAIL_FETCH_CONCURRENCY = 2;

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
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

async function scrapeAFRImmobilier(searchType = 'rent') {
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

      console.log(`[AFR Immobilier] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[AFR Immobilier] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[AFR Immobilier] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'AFR Immobilier';
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
        console.log(`[AFR Immobilier] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[AFR Immobilier] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[AFR Immobilier] Total unique listings: ${enrichedListings.length}`);

    return { source: 'AFR Immobilier', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[AFR Immobilier] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'AFR Immobilier', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeAFRImmobilier };

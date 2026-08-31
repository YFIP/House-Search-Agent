// emile-garcin-scraper.js
//
// NEW FILE. Emile Garcin — luxury agency covering Paris, Neuilly-sur-Seine,
// Côte Basque, and Belgium.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.emilegarcin.com/fr/annonces/location (French;
//     confirmed via its English mirror /en/adverts/properties-for-rent —
//     a checkbox location filter covers Paris 1st/4th/5th/6th/7th/8th/
//     14th/15th/16th, Neuilly-sur-Seine, Côte Basque, and Belgium, so the
//     unfiltered base URL returns all of these combined, not just Paris).
//   - Sale: https://www.emilegarcin.com/fr/annonces/vente (French
//     equivalent of /en/adverts/properties-for-sale — not independently
//     verified but follows the confirmed en/fr URL-swap pattern).
//   - Listing link pattern: a[href*="/annonce/"] (French) — e.g.
//     /en/advert/Location-Paris-6th-arrondissement-... in English, so
//     the French site is expected to use /annonce/ analogously; the
//     extractor also accepts the English /advert/ path as a fallback in
//     case the French site links through the English slug.
//   - Price format: "15 000 € / month" (spaces around the slash) —
//     matches parse-listing.js's rent regex directly.
//   - No pagination markers seen on the one arrondissement-filtered page
//     fetched (6 listings, no "page 2" link) — probing a `?page=N`
//     fallback defensively since the unfiltered "all locations" page is
//     likely to have more.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.emilegarcin.com/fr/annonces/location';
const SALE_URL = 'https://www.emilegarcin.com/fr/annonces/vente';
const LISTING_SELECTOR = 'a[href*="/annonce/"], a[href*="/advert/"]';
const MAX_PAGES = 10; // safety cap; pagination not directly observed
const DETAIL_FETCH_CONCURRENCY = 2;

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
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

function extractListings(selector) {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll(selector));
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
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapeEmileGarcin(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;

      console.log(`[Emile Garcin] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Emile Garcin] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings, LISTING_SELECTOR);
      console.log(`[Emile Garcin] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Emile Garcin';
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
        console.log(`[Emile Garcin] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Emile Garcin] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Emile Garcin] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Emile Garcin', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Emile Garcin] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Emile Garcin', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeEmileGarcin };

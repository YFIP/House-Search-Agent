// fredelion-scraper.js
//
// NEW FILE. Fredélion — Paris agency group, ~25 neighborhood offices
// across Paris + near suburbs (Boulogne, Neuilly, Levallois).
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.fredelion.com/fr/immobilier/location/appartement/paris
//     — 14 listings, ALL shown on one page (count in the page's own
//     heading matches the number of cards rendered — no pagination
//     needed at current inventory levels).
//   - Sale: https://www.fredelion.com/fr/immobilier/vente/appartement/paris
//     (confirmed via the site's own "Acheter" nav link, same URL
//     pattern with location->vente swapped).
//   - Listing link pattern: individual listings end in a numeric ID,
//     e.g. /fr/immobilier/location/appartement/paris/paris-16-la-muette/114051
//     — matched via a regex requiring a trailing /digits, since the
//     category/index links (e.g. .../paris) don't have one.
//   - Price format: "3 431 €/mois CC honoraires inclus" (no space
//     before €) — matches parse-listing.js's rent regex directly.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.fredelion.com/fr/immobilier/location/appartement/paris';
const SALE_URL = 'https://www.fredelion.com/fr/immobilier/vente/appartement/paris';
const MAX_PAGES = 6; // safety cap; all 14 rent listings fit on one page currently
const DETAIL_FETCH_CONCURRENCY = 2;
const LISTING_HREF_PATTERN = /\/\d+\/?$/;

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

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/immobilier/"]'));
  for (const link of links) {
    const href = link.href;
    if (!/\/\d+\/?$/.test(href)) continue; // only individual listings end in a numeric ID
    if (seen.has(href)) continue;
    seen.add(href);
    let container = link;
    let text = '';
    for (let i = 0; i < 6; i++) {
      container = container.parentElement;
      if (!container) break;
      text = container.innerText || '';
      if (text.includes('€')) break;
    }
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapeFredelion(searchType = 'rent') {
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

      console.log(`[Fredelion] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector('a[href*="/immobilier/"]', { timeout: 10000 });
      } catch (e) {
        console.log(`[Fredelion] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Fredelion] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Fredelion';
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
        console.log(`[Fredelion] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Fredelion] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Fredelion] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Fredelion', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Fredelion] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Fredelion', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeFredelion };

// tiemo-scraper.js
//
// NEW FILE. Tiemo Paris — independent agency specializing in furnished
// rentals for expats/corporate clients, Paris + near suburbs. Runs on
// the Netty real-estate platform ("Logiciel de transaction" / netty.fr
// in the footer).
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.tiemo.paris/immobilier-a-louer-Paris.htm — 12
//     listings seen on this single fetch; no numbered pagination link
//     was present in the page (city-filter links for Nanterre/Puteaux/
//     Saint-Cloud/Suresnes were the only "more" links visible), so this
//     may be the full current Paris inventory on one page. Still
//     probing a `?page=N` fallback defensively.
//   - Sale: https://www.tiemo.paris/appartement-a-vendre-Paris.htm
//     (from the footer nav's "Achat appartement Paris" link) — not
//     independently listing-count-verified.
//   - Listing link pattern: distinct per transaction type —
//     a[href*="-location-fr_"] for rent, a[href*="-vente-fr_"] for sale
//     — e.g. /immobilier/appartement-t1-paris-location-fr_LA2392.htm.
//   - Price format: "1 200 €/mois" (no spaces around the slash) —
//     matches parse-listing.js's rent regex directly.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.tiemo.paris/immobilier-a-louer-Paris.htm';
const SALE_URL = 'https://www.tiemo.paris/appartement-a-vendre-Paris.htm';
const RENT_SELECTOR = 'a[href*="-location-fr_"]';
const SALE_SELECTOR = 'a[href*="-vente-fr_"]';
const MAX_PAGES = 6; // safety cap; only 1 rent page actually observed
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

async function scrapeTiemo(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const selector = searchType === 'sale' ? SALE_SELECTOR : RENT_SELECTOR;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;

      console.log(`[Tiemo] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(selector, { timeout: 10000 });
      } catch (e) {
        console.log(`[Tiemo] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings, selector);
      console.log(`[Tiemo] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Tiemo';
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
        console.log(`[Tiemo] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Tiemo] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Tiemo] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Tiemo', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Tiemo] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Tiemo', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeTiemo };

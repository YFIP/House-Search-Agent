// orpi-scraper.js
//
// NEW FILE. Orpi is a large French franchise network — the site
// aggregates listings from ~1,250 independently-run agencies into one
// searchable Paris-wide feed per transaction type.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.orpi.com/location-immobiliere-paris/louer-appartement/
//     — 23 listings, 2 pages (`?page=2`).
//   - Sale: https://www.orpi.com/annonces-immobilieres-paris/vente-appartement/
//     — 451 listings, 31 pages (`?page=2` ... `?page=31`) — simple
//     URL-based pagination, no JS click needed.
//   - Listing link pattern: distinct per transaction type —
//     a[href*="/annonce-location-appartement-"] for rent,
//     a[href*="/annonce-vente-appartement-"] for sale — both end in a
//     UUID, so no risk of collisions with nav/agency links.
//   - Price format: "7 790 € par mois" (rent) / "290 000 €" (sale) —
//     neither has the "€/mois" slash parse-listing.js's rent-specific
//     regex requires, so both correctly fall through to its generic
//     price regex (digits-then-€, no slash required) — same situation
//     already confirmed working for Perenium.
//   - Page is plain server-rendered HTML (confirmed via a non-JS fetch),
//     so Puppeteer's default `domcontentloaded` wait is sufficient —
//     no extra JS-render wait needed.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.orpi.com/location-immobiliere-paris/louer-appartement/';
const SALE_URL = 'https://www.orpi.com/annonces-immobilieres-paris/vente-appartement/';
const RENT_SELECTOR = 'a[href*="/annonce-location-appartement-"]';
const SALE_SELECTOR = 'a[href*="/annonce-vente-appartement-"]';
const MAX_PAGES = 35; // safety cap just above the 31 sale pages actually observed
const DETAIL_FETCH_CONCURRENCY = 3;

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

    if (text.includes('€')) {
      results.push({ url: href, rawText: text.slice(0, 500) });
    }
  }

  return results;
}

async function scrapeOrpi(searchType = 'rent') {
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

      console.log(`[Orpi] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(selector, { timeout: 10000 });
      } catch (e) {
        console.log(`[Orpi] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings, selector);
      console.log(`[Orpi] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Orpi';
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
        console.log(`[Orpi] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Orpi] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Orpi] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Orpi', searchType, listings: enrichedListings, error: null };

  } catch (error) {
    console.error(`[Orpi] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Orpi', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeOrpi };

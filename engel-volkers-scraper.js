// engel-volkers-scraper.js
//
// NEW FILE. Engel & Völkers — international luxury franchise, several
// Paris shops (Le Marais, Champ de Mars, Passy, Faubourg Saint-Honoré).
//
// VERIFIED LIVE (2026-08-30, URL corrected 2026-08-31 after a live run
// returned 0 listings):
//   - BUG FOUND: the original URL was
//     /fr/fr/properties/res/rent/real-estate/ile-de-france/paris —
//     built by assuming a language-code swap (en->fr) keeps the same
//     English path segments. It doesn't. The site requires *translated*
//     path segments for French: propriete/res/vendre/immobilier
//     (confirmed live: /fr/fr/propriete/res/vendre/immobilier/ile-de-france
//     returns 485 results). The old URL 404s/redirects, so
//     waitForSelector always timed out -> 0 listings, every run.
//   - FIX: switched to the CONFIRMED-WORKING English-content URL under
//     the France site instead — /fr/en/properties/res/{rent,sale}/real-estate/ile-de-france/paris
//     — this is the exact URL originally verified live with the
//     a[href*="/exposes/"] selector, just with the language segment
//     corrected from /fr/fr/ to /fr/en/.
//   - Sale: https://www.engelvoelkers.com/fr/en/properties/res/sale/real-estate/ile-de-france/paris
//   - Listing link pattern: a[href*="/exposes/"] — e.g.
//     /fr/en/exposes/a5807bf0-42a1-553d-9d39-33712367c712 — a UUID-based
//     path, very distinct, no risk of matching nav links.
//   - Price format: "Total rent\n€5,500" — parse-listing.js's generic
//     saleAfter/saleBefore price regex only needs a number immediately
//     before "€" (no "/mois" required), so this extracts correctly.
//   - Pagination showed "Next page"/"1"/"2" controls but no visible raw
//     href in the fetched markup (likely a Next.js app) — probing a
//     `?page=N` fallback defensively; degrades to page-1-only if wrong.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.engelvoelkers.com/fr/en/properties/res/rent/real-estate/ile-de-france/paris';
const SALE_URL = 'https://www.engelvoelkers.com/fr/en/properties/res/sale/real-estate/ile-de-france/paris';
const LISTING_SELECTOR = 'a[href*="/exposes/"]';
const MAX_PAGES = 8; // safety cap; only 2 rent pages actually observed
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

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/exposes/"]'));
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

async function scrapeEngelVolkers(searchType = 'rent') {
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

      console.log(`[Engel & Völkers] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Engel & Völkers] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Engel & Völkers] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Engel & Völkers';
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
        console.log(`[Engel & Völkers] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Engel & Völkers] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Engel & Völkers] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Engel & Völkers', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Engel & Völkers] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Engel & Völkers', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeEngelVolkers };

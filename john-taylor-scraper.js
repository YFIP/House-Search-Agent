// john-taylor-scraper.js
//
// NEW FILE. John Taylor — international luxury agency (Artcurial Group),
// 2 Paris shops plus "Autour de Paris".
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.john-taylor.fr/france/location/appartement/paris/
//     — 12 listings, single page ("Page 1" shown, no page 2 link).
//   - Sale: https://www.john-taylor.fr/france/vente/appartement/paris/
//     (confirmed via the site's own footer link "Vente Appartement Paris").
//   - Listing link pattern: paths always include "/paris-rive-droite/" or
//     "/paris-rive-gauche/" (Paris's two riverbank divisions), e.g.
//     /france/location/appartement/paris/paris-rive-gauche/paris-7eme/
//     gros-caillou/L0826PA/ — matched via a[href*="/paris-rive-"].
//   - IMPORTANT price format quirk: listings show "14 900 EUR / Mois" —
//     the literal text "EUR", not the "€" symbol. parse-listing.js's
//     price regexes are unconditionally "€"-based, so without
//     normalization this source would silently extract price = 0 for
//     every listing. Fixed by rewriting "<number> EUR" to "<number> €"
//     in the raw text before handing it to parseListing().
//   - Sort links (?sort=price_asc etc.) confirm the site supports query
//     params, but no page-number param was seen; single page for Paris
//     rentals currently. Probing a `?page=N` fallback defensively.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.john-taylor.fr/france/location/appartement/paris/';
const SALE_URL = 'https://www.john-taylor.fr/france/vente/appartement/paris/';
const LISTING_SELECTOR = 'a[href*="/paris-rive-"]';
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

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/paris-rive-"]'));
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
      if (/EUR|€/.test(text)) break;
    }
    if (/EUR|€/.test(text)) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapeJohnTaylor(searchType = 'rent') {
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

      console.log(`[John Taylor] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[John Taylor] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[John Taylor] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        // Normalize "<number> EUR" to "<number> €" — see header note.
        // parse-listing.js's price regexes only recognize "€".
        const normalizedText = item.rawText.replace(/(\d)(\s*)EUR\b/gi, '$1$2€');
        const listing = parseListing(normalizedText);
        listing.url = item.url;
        listing.source = 'John Taylor';
        listing.searchType = searchType;
        listing.isExactListing = true;
        const details = extractDetailFeatures(normalizedText);
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
        console.log(`[John Taylor] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[John Taylor] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[John Taylor] Total unique listings: ${enrichedListings.length}`);

    return { source: 'John Taylor', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[John Taylor] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'John Taylor', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeJohnTaylor };

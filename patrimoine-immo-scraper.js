// patrimoine-immo-scraper.js
//
// NEW FILE. Patrimoine Immobilier (formerly "Rent Your Paris") —
// furnished/corporate housing focus, Paris + near suburbs.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://patrimoine-immo.com/annonce-immobiliere/ — 39
//     listings, CONFIRMED real page-2 link:
//     https://patrimoine-immo.com/annonce-immobiliere/?page=2.
//   - Sale: same base URL with a type filter — the page has "Type:
//     Achat / Location" checkboxes but no filter was applied on the
//     fetched view (which returned only rentals, all ".../mois"
//     prices), so `?type=achat` is a reasonable but NOT independently
//     confirmed guess for the sale URL.
//   - Listing link pattern: individual listings are
//     /annonce-immobiliere/{numericId}-{slug}/ (numeric ID prefix) —
//     matched via a regex on the href, not a plain selector, since the
//     index page itself also lives at /annonce-immobiliere/ and would
//     otherwise self-match.
//   - Price format: "725€ / mois" (no space before €, space around
//     slash) — matches parse-listing.js's rent regex directly.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://patrimoine-immo.com/annonce-immobiliere/';
const SALE_URL = 'https://patrimoine-immo.com/annonce-immobiliere/?type=achat';
const MAX_PAGES = 10; // safety cap, above the 2 pages actually observed
const DETAIL_FETCH_CONCURRENCY = 2;
const LISTING_HREF_PATTERN = /\/annonce-immobiliere\/\d+-/;

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
  const links = Array.from(document.querySelectorAll('a[href*="/annonce-immobiliere/"]'));
  for (const link of links) {
    const href = link.href;
    if (!/\/annonce-immobiliere\/\d+-/.test(href)) continue; // skip the index page itself
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (link.innerText || '').trim();
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapePatrimoineImmo(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1
        ? baseUrl
        : baseUrl.includes('?') ? `${baseUrl}&page=${pageNum}` : `${baseUrl}?page=${pageNum}`;

      console.log(`[Patrimoine Immo] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector('a[href*="/annonce-immobiliere/"]', { timeout: 10000 });
      } catch (e) {
        console.log(`[Patrimoine Immo] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Patrimoine Immo] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Patrimoine Immo';
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
        console.log(`[Patrimoine Immo] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Patrimoine Immo] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Patrimoine Immo] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Patrimoine Immo', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Patrimoine Immo] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Patrimoine Immo', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapePatrimoineImmo };

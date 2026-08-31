// palais-royal-immobilier-scraper.js
//
// NEW FILE. "A1" Palais-Royal Immobilier — boutique agency specializing
// in Paris 1er/2e and the historic center.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.palaisroyalimmobilier.com/offre/location/
//   - Sale: https://www.palaisroyalimmobilier.com/offre/vente/
//     (confirmed via the site's own "Acheter" nav link).
//   - IMPORTANT: like Luxe Prestige Immo, this catalog freely mixes
//     currently-available listings with already-let ones — most cards
//     on the fetched page were prefixed "Loué Réf. ..." (already
//     rented), with only one genuinely active listing visible. Filtered
//     by skipping any card whose text starts with/contains "Loué" or
//     "Vendu" (case-insensitive) — otherwise this source would report
//     almost entirely stale/unavailable listings as live.
//   - Listing link pattern: a[href*="/annonce/"] — e.g.
//     /annonce/cppkg/ or /annonce/sh24-paris-1er-studio-location-meublee-.../
//   - Price format: "200 €/mois/hc" (no space before €, extra "/hc"
//     suffix after "mois") — parse-listing.js's rent regex only
//     requires "€...(mois|month)" with slash-tolerant spacing before
//     "mois", not after, so the trailing "/hc" doesn't interfere.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.palaisroyalimmobilier.com/offre/location/';
const SALE_URL = 'https://www.palaisroyalimmobilier.com/offre/vente/';
const LISTING_SELECTOR = 'a[href*="/annonce/"]';
const MAX_PAGES = 6; // safety cap; pagination not directly observed (~15 cards seen)
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
  const links = Array.from(document.querySelectorAll('a[href*="/annonce/"]'));
  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (link.innerText || '').trim();
    // Skip cards already marked let/sold — see header note.
    const lower = text.toLowerCase();
    if (lower.includes('lou\u00e9') || lower.includes('loue') || lower.includes('vendu')) continue;
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapePalaisRoyalImmobilier(searchType = 'rent') {
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

      console.log(`[Palais Royal Immobilier] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Palais Royal Immobilier] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Palais Royal Immobilier] Page ${pageNum}: ${raw.length} active (unlet/unsold) items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Palais Royal Immobilier';
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
        console.log(`[Palais Royal Immobilier] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Palais Royal Immobilier] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Palais Royal Immobilier] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Palais Royal Immobilier', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Palais Royal Immobilier] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Palais Royal Immobilier', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapePalaisRoyalImmobilier };

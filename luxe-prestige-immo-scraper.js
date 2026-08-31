// luxe-prestige-immo-scraper.js
//
// NEW FILE. The domain luxe-prestige-immo.com (from the original agency
// list) now hosts "Anne B Estate", a single-agent Paris boutique —
// same site, rebranded. Kept the source name matching the site's actual
// current branding for clarity in the output data.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.luxe-prestige-immo.com/immobilier/locations.html
//     (this exact URL, from the original list, is confirmed still live).
//   - Sale: https://www.luxe-prestige-immo.com/immobilier/ventes.html
//     (confirmed via the site's own "VENTE" nav tab).
//   - IMPORTANT: the listing catalog freely mixes currently-available
//     properties with ones already sold/let — each card that's no
//     longer available carries a visible marker in its text ("Vendu par
//     l'agence", "LOUÉ PAR L'AGENCE", "Loué par l'agence décembre
//     2025", etc). Without filtering these out, this source would
//     report stale/unavailable listings as live. Filtered by skipping
//     any card whose text contains "vendu" or "lou" (catches "loué",
//     "louée", "LOUE", accented or not).
//   - Listing link pattern: property URLs sit under /appartements/,
//     /maisons/, or /hotels_particuliers/ — matched via
//     a[href*="/appartements/"], a[href*="/maisons/"],
//     a[href*="/hotels_particuliers/"].
//   - Price format: "1300€ CC" / "2659€cc" (no space before €, lowercase
//     "cc" for "charges comprises") — parse-listing.js's generic price
//     regex only needs a number immediately before "€", so this parses
//     correctly without changes.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.luxe-prestige-immo.com/immobilier/locations.html';
const SALE_URL = 'https://www.luxe-prestige-immo.com/immobilier/ventes.html';
const LISTING_SELECTOR = 'a[href*="/appartements/"], a[href*="/maisons/"], a[href*="/hotels_particuliers/"]';
const MAX_PAGES = 6; // safety cap; pagination not directly observed (~14 listings seen)
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
    // Skip cards already marked sold/let — see header note. Checks for
    // "vendu" and "lou" (catches loué/louée/LOUE, any case/accent).
    const lower = text.toLowerCase();
    if (lower.includes('vendu') || lower.includes('lou')) continue;
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 600) });
  }
  return results;
}

async function scrapeLuxePrestigeImmo(searchType = 'rent') {
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

      console.log(`[Luxe Prestige Immo] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Luxe Prestige Immo] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings, LISTING_SELECTOR);
      console.log(`[Luxe Prestige Immo] Page ${pageNum}: ${raw.length} active (unsold/unlet) items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Luxe Prestige Immo';
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
        console.log(`[Luxe Prestige Immo] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Luxe Prestige Immo] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Luxe Prestige Immo] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Luxe Prestige Immo', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Luxe Prestige Immo] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Luxe Prestige Immo', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeLuxePrestigeImmo };

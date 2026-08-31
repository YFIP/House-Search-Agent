// nicolas-devillard-scraper.js
//
// NEW FILE. Nicolas Devillard Immobilier — high-end Paris west/center
// rentals and sales, WordPress-based site.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent (French): https://www.nicolas-devillard.fr/category/location/
//     (confirmed via its English mirror, /en/category/for-rent/ — 18
//     listings, all on one page, no pagination links present in the
//     fetched markup).
//   - Sale (French): https://www.nicolas-devillard.fr/category/vente/
//     — NOT independently verified; inferred from the English nav
//     ("For Sale" -> /en/category/for-sale/, so French is presumably
//     the analogous /category/vente/). Falls back safely (returns zero
//     listings, not an error) if this guess is wrong.
//   - Listing link pattern: a[href*="/propriete/"] — e.g.
//     /propriete/pont-de-saint-cloud-calme-lumineux-et-belle-vue-boulogne-92/
//   - Price format: "€ 1.100 / month (ci)" — note the PERIOD as
//     thousands separator (not the usual French space), and "month" in
//     English even on some listings. parse-listing.js's PRICE_NUMBER
//     already accepts "." as a separator and its regex already accepts
//     "month" alongside "mois", so no format-specific handling needed.
//   - No WordPress `/page/2/`-style pagination observed on the rent
//     archive; still probing that pattern defensively (safety cap) in
//     case the live inventory grows past one page.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.nicolas-devillard.fr/category/location/';
const SALE_URL = 'https://www.nicolas-devillard.fr/category/vente/';
const LISTING_SELECTOR = 'a[href*="/propriete/"]';
const MAX_PAGES = 6; // safety cap; only 1 page actually observed for rent
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
  // Each card repeats its own <a href="/propriete/...">, once per
  // heading/title/image — dedupe on href, then walk up to a container
  // wide enough to contain the price line.
  const links = Array.from(document.querySelectorAll('a[href*="/propriete/"]'));
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

async function scrapeNicolasDevillard(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? baseUrl : `${baseUrl}page/${pageNum}/`;

      console.log(`[Nicolas Devillard] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Nicolas Devillard] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Nicolas Devillard] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Nicolas Devillard';
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
        console.log(`[Nicolas Devillard] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Nicolas Devillard] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Nicolas Devillard] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Nicolas Devillard', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Nicolas Devillard] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Nicolas Devillard', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeNicolasDevillard };

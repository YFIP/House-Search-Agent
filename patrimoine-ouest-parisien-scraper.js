// patrimoine-ouest-parisien-scraper.js
//
// NEW FILE. Patrimoine Ouest Parisien runs on the Orisha/Poliris
// real-estate platform (footer confirms "realestate.orisha.com") — same
// underlying template as Paris Seine Immobilier and AFR Immobilier (see
// those files), just a different agency's data on it.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.patrimoineouestparisien.fr/annonces/transaction/Location.html
//     — 60 listings, confirmed live.
//   - Listing link pattern: a[href*="/fiches/"] — e.g.
//     /fiches/4-39_61177570/maison-saint-cloud-12-piece-s-463-m2.html
//   - Price format: "Loyer 21 500 €/mois" (rent) — matches
//     parse-listing.js's rent-specific "€/mois" regex directly.
//   - Pagination: VERIFIED live — real page-2/page-3 links seen at the
//     bottom of the results, using the pattern
//     .../annonces/transaction_____2/location.html (page number inserted
//     before the trailing filename).

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.patrimoineouestparisien.fr/annonces/transaction/Location.html';
const SALE_URL = 'https://www.patrimoineouestparisien.fr/annonces/transaction/Vente.html';
const LISTING_SELECTOR = 'a[href*="/fiches/"]';
const MAX_PAGES = 15; // safety cap, well above the ~2-3 pages actually observed
const DETAIL_FETCH_CONCURRENCY = 2;

// BUG FIX (2026-09-01): live evidence showed this site's listing links
// (/fiches/...) are 100% present via a plain HTTP fetch, yet Puppeteer
// found zero — the signature of basic headless-browser fingerprint
// detection (checking navigator.webdriver etc.), not a selector or
// content problem. Switched to puppeteer-extra + the stealth plugin,
// which patches these fingerprints. The dependency was already being
// installed for this job (scrape-main) but never actually used in code
// anywhere in this repo — confirmed by checking every other scraper.
async function getBrowser() {
  const puppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

function pageUrl(baseUrl, pageNum) {
  if (pageNum === 1) return baseUrl;
  // Orisha platform's observed pattern: insert "_____N" before the
  // trailing filename, e.g. .../transaction/Location.html ->
  // .../transaction_____2/Location.html
  return baseUrl.replace(/\/([^/]+)\.html$/, `_____${pageNum}/$1.html`);
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
  const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);
    let container = link.closest('div') || link.parentElement;
    for (let i = 0; i < 5 && container && container.innerText.length < 30; i++) {
      container = container.parentElement;
    }
    const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 500) });
  }
  return results;
}

async function scrapePatrimoineOuestParisien(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageUrl(baseUrl, pageNum);

      console.log(`[Patrimoine Ouest Parisien] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Patrimoine Ouest Parisien] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Patrimoine Ouest Parisien] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Patrimoine Ouest Parisien';
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
        console.log(`[Patrimoine Ouest Parisien] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Patrimoine Ouest Parisien] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Patrimoine Ouest Parisien] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Patrimoine Ouest Parisien', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Patrimoine Ouest Parisien] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Patrimoine Ouest Parisien', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapePatrimoineOuestParisien };

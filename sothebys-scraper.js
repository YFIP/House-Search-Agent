// sothebys-scraper.js
//
// NEW FILE. Propriétés Parisiennes Sotheby's International Realty — 4
// Paris offices (6th, 7th, 8th, 9th arrondissements).
//
// VERIFIED LIVE (2026-08-30, re-checked 2026-08-31 after a live run
// returned 0 listings):
//   - Rent (French): https://www.proprietesparisiennes-sothebysrealty.com/fr/location-appartement-luxe-paris/&new_research=1
//     — the odd "&new_research=1" (no leading "?") is genuinely the
//     site's real URL scheme, not a mistake on our part — confirmed via
//     Google's own index of the site using this exact pattern on
//     multiple pages. So the URL is not the bug.
//   - Sale (French): https://www.proprietesparisiennes-sothebysrealty.com/fr/vente-appartement-luxe-paris/&new_research=1
//   - Listing link pattern: a[href*="/paris-real-estate/ref-"] — e.g.
//     /en/paris-real-estate/ref-pp2-3594/rental-apartment-paris-8-rooms-...
//   - BUG FIX: added a cookie-consent-accept step (this scraper never
//     had one) and bumped waitForSelector's timeout (10s -> 20s), plus
//     diagnostic logging when the selector never appears — see the
//     matching note in helix-immobilier-scraper.js for the reasoning.
//     Root cause is still not confirmed (bot-blocking on the CI runner's
//     IP vs. a consent gate vs. slow client-side rendering are all
//     plausible for a page that demonstrably has real content) — the
//     diagnostic log is there so the next run tells us which.
//   - Price format: "35,000 € / month" (English, comma thousands
//     separator) — parse-listing.js's SEP class already includes comma
//     as a valid separator, so this (and the French "35 000 € / mois"
//     equivalent) both parse correctly without changes.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.proprietesparisiennes-sothebysrealty.com/fr/location-appartement-luxe-paris/&new_research=1';
const SALE_URL = 'https://www.proprietesparisiennes-sothebysrealty.com/fr/vente-appartement-luxe-paris/&new_research=1';
const LISTING_SELECTOR = 'a[href*="/paris-real-estate/ref-"]';
const MAX_PAGES = 6; // safety cap; "Load more" is likely JS-driven, not URL-based
const DETAIL_FETCH_CONCURRENCY = 2;

// BUG FIX (2026-09-02): switched to puppeteer-extra + stealth plugin,
// same fix that took AFR Immobilier from 0 to 18 listings. This
// scraper never got that fix applied — still plain puppeteer. The
// dependency is already installed for this job (scrape-main).
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
  const links = Array.from(document.querySelectorAll('a[href*="/paris-real-estate/ref-"]'));
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

async function scrapeSothebys(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = pageNum === 1 ? baseUrl : `${baseUrl}&page=${pageNum}`;

      console.log(`[Sotheby's] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      // Accept cookie banner if present — this scraper never had this
      // step before. Harmless if there's no banner.
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).forEach(btn => {
          const t = (btn.innerText || '').toLowerCase();
          if (t.includes('accepter') || t.includes('autoriser') || t.includes('tout accepter') || t.includes('accept')) btn.click();
        });
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 20000 });
      } catch (e) {
        // DIAGNOSTIC (2026-08-31): see helix-immobilier-scraper.js for
        // why this exists — tells us next run whether this is a
        // bot-block or something else.
        const diag = await page.evaluate(() => ({
          title: document.title,
          bodyLength: (document.body && document.body.innerText || '').length
        })).catch(() => ({ title: '(eval failed)', bodyLength: -1 }));
        console.log(`[Sotheby's] No listings found on page ${pageNum} — assuming end of results. DIAG: title="${diag.title}" bodyTextLength=${diag.bodyLength}`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Sotheby's] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = "Sotheby's";
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
        console.log(`[Sotheby's] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Sotheby's] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Sotheby's] Total unique listings: ${enrichedListings.length}`);

    return { source: "Sotheby's", searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Sotheby's] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: "Sotheby's", searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeSothebys };

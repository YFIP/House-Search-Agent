// danielfeau-scraper.js
//
// FIX (this pass): enrichWithDetails() used to unconditionally overwrite
// elevator/balcony/furnished with whatever the detail-page fetch
// returned — including on a FAILED fetch, which returns nulls. That
// silently wiped out values the earlier summary-card pass (in
// scrapeLocation, below) had already found correctly. Now uses the
// shared mergeFeature() helper: a successful detail-page fetch still
// wins (it's the more complete source), but a failed one just leaves
// the summary-card value in place instead of erasing it.
//
// VERIFIED LIVE:
//   - https://danielfeau.com/fr/location/paris (all-Paris, page 1 of 10,
//     confirmed real listings with correct France-only scope — no
//     international/other-city contamination observed in results shown,
//     despite the page's location-picker UI listing many global cities)
//   - Pagination: simple URL-based (?page=2 through ?page=10)
//   - Listing link pattern: /annonce-immobiliere/{numeric-id} — clean,
//     distinctive, e.g. /annonce-immobiliere/87180044
//   - Suburb-specific URLs already confirmed to exist:
//     /fr/listing/france/location/neuilly, /boulogne, /saint-cloud
//   - Price format: "3 530 € / Mois (Charges comprises)" — matches the
//     existing rent-specific regex directly (has the slash).
//   - Address format: "Paris 5ème (75005)" — standard "ème" format,
//     already handled.
//   - Room-count concatenation bug found and fixed in parse-listing.js:
//     "4 pièces2 chambres" (no space) was silently losing the real room
//     count — fixed at the shared-parser level, benefits every source.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const LISTING_SELECTOR = 'a[href*="/annonce-immobiliere/"]';
const MAX_PAGES = 25;
const MAX_TOTAL_LISTINGS = 600;

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

const DETAIL_FETCH_CONCURRENCY = 2;

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
      // FIXED: mergeFeature prefers the detail-page value when present,
      // but falls back to whatever the summary-card pass already found
      // instead of clobbering it with a failed-fetch null.
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
      results.push({ url: href.split('?')[0], rawText: text.slice(0, 500) });
    }
  }

  return results;
}

async function scrapeLocation(browser, baseUrl, maxPages, searchType, seenUrls, allListings) {
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;

    console.log(`[DanielFeau] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    try {
      await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
    } catch (e) {
      console.log(`[DanielFeau] No listings found on page ${pageNum} of ${baseUrl} — assuming end of results.`);
      await page.close();
      break;
    }

    const raw = await page.evaluate(extractListings);
    console.log(`[DanielFeau] ${baseUrl} page ${pageNum}: ${raw.length} raw items`);

    let newCount = 0;
    for (const item of raw) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      const listing = parseListing(item.rawText);
      listing.url = item.url;
      listing.source = 'DanielFeau';
      listing.searchType = searchType;
      listing.isExactListing = true;
      // Same pattern proven for Junot/Eiffel Housing: try the cheap
      // summary-card text first — returns null honestly for fields not
      // present in the text, picks up real data for fields that are.
      // enrichWithDetails() below then only OVERRIDES this with a
      // detail-page value when the detail fetch actually succeeded.
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
      console.log(`[DanielFeau] Page ${pageNum} of ${baseUrl} had no new listings — stopping this location.`);
      break;
    }
    if (allListings.length >= MAX_TOTAL_LISTINGS) {
      console.log(`[DanielFeau] Reached ${MAX_TOTAL_LISTINGS}-listing cap — stopping.`);
      return;
    }
  }
}

async function scrapeDanielFeau(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const allListings = [];
    const seenUrls = new Set();

    const mainUrl = searchType === 'sale'
      ? 'https://danielfeau.com/fr/listing/france/vente/appartements/paris'
      : 'https://danielfeau.com/fr/location/paris';

    await scrapeLocation(browser, mainUrl, MAX_PAGES, searchType, seenUrls, allListings);

    if (allListings.length < MAX_TOTAL_LISTINGS) {
      const suburbUrls = searchType === 'sale'
        ? [
            'https://danielfeau.com/fr/listing/france/vente/appartements/neuilly',
            'https://danielfeau.com/fr/listing/france/vente/appartements/boulogne',
            'https://danielfeau.com/fr/listing/france/vente/appartements/saint-cloud'
          ]
        : [
            'https://danielfeau.com/fr/listing/france/location/neuilly',
            'https://danielfeau.com/fr/listing/france/location/boulogne',
            'https://danielfeau.com/fr/listing/france/location/saint-cloud'
          ];
      for (const url of suburbUrls) {
        if (allListings.length >= MAX_TOTAL_LISTINGS) break;
        await scrapeLocation(browser, url, 10, searchType, seenUrls, allListings);
      }
    }

    console.log(`[DanielFeau] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[DanielFeau] Total unique listings: ${enrichedListings.length}`);

    return { source: 'DanielFeau', searchType, listings: enrichedListings, error: null };

  } catch (error) {
    console.error(`[DanielFeau] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'DanielFeau', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeDanielFeau };

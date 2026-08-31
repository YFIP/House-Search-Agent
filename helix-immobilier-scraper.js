// helix-immobilier-scraper.js
//
// NEW FILE. Helix Immobilier covers Saint-Germain-en-Laye, Le Pecq, Le
// Vésinet and the western suburbs (not Paris intra-muros) — runs on the
// Jalis real-estate platform.
//
// VERIFIED LIVE (2026-08-30):
//   - Rent: https://www.heliximmobilier.com/location-w1
//     — real pagination confirmed: location-w2, location-w3 ... location-w4
//     (4 pages seen in the page's own pager).
//   - Sale: https://www.heliximmobilier.com/vente-w1 (same "-wN" pattern
//     assumed for pagination; not independently page-count-verified, but
//     the URL scheme itself — vente-w1 as the sale-listing landing page —
//     is confirmed from the site's own nav menu).
//   - Listing link pattern: a[href*="/details-"] — e.g.
//     /details-chambourcy+location+d+un+appartement+de+2+pieces+au+calme-2371
//   - Price format: "4 500\n €  /mois\n Mensuel" — note the real line
//     break between the number and "€" in the rendered text. Collapsing
//     whitespace (including newlines) before handing rawText to
//     parse-listing.js, since its price regex tolerates spaces but not
//     literal newlines between the digits and "€".

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const RENT_URL = 'https://www.heliximmobilier.com/location-w';
const SALE_URL = 'https://www.heliximmobilier.com/vente-w';
const LISTING_SELECTOR = 'a[href*="/details-"]';
const MAX_PAGES = 10; // safety cap, well above the 4 rent pages actually observed
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
  const links = Array.from(document.querySelectorAll('a[href*="/details-"]'));
  for (const link of links) {
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);
    let container = link.closest('div') || link.parentElement;
    for (let i = 0; i < 5 && container && container.innerText.length < 30; i++) {
      container = container.parentElement;
    }
    // Collapse all whitespace (including real newlines between the price
    // number and "€") to single spaces — see header note.
    const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';
    if (text.includes('€')) results.push({ url: href, rawText: text.slice(0, 500) });
  }
  return results;
}

async function scrapeHelixImmobilier(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const baseUrl = searchType === 'sale' ? SALE_URL : RENT_URL;
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const url = `${baseUrl}${pageNum}`;

      console.log(`[Helix Immobilier] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Helix Immobilier] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Helix Immobilier] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Helix Immobilier';
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
        console.log(`[Helix Immobilier] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Helix Immobilier] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Helix Immobilier] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Helix Immobilier', searchType, listings: enrichedListings, error: null };
  } catch (error) {
    console.error(`[Helix Immobilier] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Helix Immobilier', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeHelixImmobilier };

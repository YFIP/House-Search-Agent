// perenium-scraper.js
//
// FIX (this pass): enrichWithDetails() intentionally preferred the
// detail-page value over the summary-card value (correct — detail pages
// are more reliable here), but did so with a plain unconditional
// assignment, which meant a FAILED detail-page fetch (returning nulls)
// still overwrote a real value the summary-card pass had already found.
// Now uses mergeFeature(detailValue, summaryValue) — same stated
// preference (detail page wins when present), but a failed fetch no
// longer erases a known-good fallback.
//
// VERIFIED LIVE:
//   - https://www.perenium.eu/location.php (page 1) — "14 annonces" total,
//     tiny inventory, well under our 100-per-source cap.
//   - https://www.perenium.eu/location.php?Page=2 (page 2) — simple
//     URL-based pagination, same easy pattern as Book-a-Flat.
//   - Listing link pattern: /fiche-{type}-a-louer-{location}-ref-{id}.php
//     — clean, distinctive, e.g.
//     /fiche-studio-a-louer-levallois-perret-ref-3010737.php
//   - SUBURBS ALREADY INCLUDED: the single search combines Paris
//     arrondissements AND suburb towns (Levallois-Perret, Suresnes,
//     Saint-Germain-en-Laye all seen live) — same as Book-a-Flat, no
//     separate suburb-specific scraping needed.
//   - Room format: "T2", "T3", "T4", "T5" notation directly in the title
//     — already matches parse-listing.js's existing \bT(\d+)\b regex.
//   - Price format: "825 € charges comprises par mois" — NO slash before
//     "mois" (unlike Barnes/SeLoger's "€ /mois"). Won't match the rent-
//     specific regex, but correctly falls through to the generic
//     saleAfter/saleBefore price regex, which doesn't require a slash —
//     confirmed working via testing before this was built.
//   - Address format inconsistent by design: "PARIS 10EME ARRONDISSEMENT"
//     for Paris listings (already matches existing regex), but suburb-only
//     listings ("LEVALLOIS-PERRET", "SURESNES") have no "Paris" prefix at
//     all. Since this ONE page mixes many different locations together
//     (unlike SeLoger/Barnes suburbs, where we scrape one known town at a
//     time), we can't override with a known location here — text parsing
//     is the only option, same situation as Barnes/SeLoger's main Paris
//     scrapers. The fallback (first non-badge non-price line) should still
//     surface a readable location from the listing's own title text.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const BASE_URL = 'https://www.perenium.eu/location.php';
const LISTING_SELECTOR = 'a[href*="/fiche-"]';
const MAX_PAGES = 5; // safety cap well above the ~2 pages actually observed

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
    // Detail pages are the primary/preferred source here (more reliable
    // than the brief summary card), so the detail-page value wins when
    // it's actually present — but a failed fetch (d.field === null) now
    // falls back to whatever the summary-card pass already found,
    // instead of unconditionally overwriting it with null.
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
  const links = Array.from(document.querySelectorAll('a[href*="/fiche-"]'));

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

async function scrapePerenium(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const allListings = [];
    const seenUrls = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(20000);
      const saleBaseUrl = 'https://www.perenium.eu/vente.php';
      const currentBaseUrl = searchType === 'sale' ? saleBaseUrl : BASE_URL;
      const url = pageNum === 1 ? currentBaseUrl : `${currentBaseUrl}?Page=${pageNum}`;

      console.log(`[Perenium] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 10000 });
      } catch (e) {
        console.log(`[Perenium] No listings found on page ${pageNum} — assuming end of results.`);
        await page.close();
        break;
      }

      const raw = await page.evaluate(extractListings);
      console.log(`[Perenium] Page ${pageNum}: ${raw.length} raw items`);

      let newCount = 0;
      for (const item of raw) {
        if (seenUrls.has(item.url)) continue;
        if (searchType === 'sale' && /\bvendu\b/i.test(item.rawText)) continue;
        seenUrls.add(item.url);
        const listing = parseListing(item.rawText);
        listing.url = item.url;
        listing.source = 'Perenium';
        listing.searchType = searchType;
        listing.isExactListing = true;
        // Summary-card text rarely states elevator/furnished/bathroom -
        // real detail-page enrichment (below, after this loop) is the
        // primary source now. This fills in anything already available
        // from the summary as a fallback only.
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
        console.log(`[Perenium] Page ${pageNum} had no new listings — stopping.`);
        break;
      }
    }

    console.log(`[Perenium] Fetching detail pages for ${allListings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithDetails(browser, allListings);

    await browser.close();
    console.log(`[Perenium] Total unique listings: ${enrichedListings.length}`);

    return { source: 'Perenium', searchType, listings: enrichedListings, error: null };

  } catch (error) {
    console.error(`[Perenium] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Perenium', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapePerenium };

// netlify/functions/scrape-runner.js
// Scoped to Barnes only. Handles the "Next listings" AJAX pagination
// (javascript:annonces_suivantes()) to reach up to MAX_LISTINGS before any
// price/room/etc. filtering happens — filtering is applied later, in
// search.js, on the full pulled set.
//
// FIXES (this pass), three separate issues found:
//
// 1. This file never called extractDetailFeatures() on the summary-card
//    text at all — elevator/balcony/furnished only ever came from the
//    (optional, see #2) detail-page enrichment step. Added a summary-card
//    pass in scrapeBarnes(), same pattern already proven for Junot/
//    DanielFeau/Book-a-Flat/Perenium/Barnes-Suburbs, so these fields have
//    a real value even before/without detail-page enrichment.
//
// 2. `fetchDetails` defaulted to `false`, meaning any call site that
//    forgot to explicitly opt in got a furnished-blind dataset with no
//    indication anything was wrong. Given elevator/balcony/furnished are
//    genuinely richer on the detail page (per the live evidence in this
//    file's own comments), defaulted to `true` instead — the caller can
//    still explicitly pass `fetchDetails: false` to skip it if needed for
//    a time-budget reason.
//
// 3. enrichWithDetails() used `{ ...listing, ...details[i] }`, which (a)
//    unconditionally overwrote elevator/balcony/furnished with a failed
//    fetch's nulls, erasing whatever the new summary-card pass (#1) had
//    already found, and (b) added bathroomsFromDetail/bedroomsFromDetail
//    as their OWN new keys on the listing object without ever merging
//    them into the actual bathrooms/bedrooms fields the rest of the app
//    reads — meaning that data was captured then silently discarded.
//    Rewritten to use the shared mergeFeature() helper and to merge into
//    the correct field names.

const { getBarnesConfig } = require('./source-config');
const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const MAX_LISTINGS_BY_TYPE = { rent: 200, sale: 1000 };
const MAX_PAGE_CLICKS_BY_TYPE = { rent: 15, sale: 50 };
const DETAIL_FETCH_CONCURRENCY = 3;

async function getBrowser() {
  const browserWSEndpoint = process.env.CATALYST_CDP_URL;

  if (browserWSEndpoint) {
    const puppeteerCore = require('puppeteer-core');
    const browser = await withTimeout(
      puppeteerCore.connect({
        browserWSEndpoint,
        defaultViewport: { width: 1920, height: 1080 }
      }),
      30000,
      'Connecting to remote browser (CATALYST_CDP_URL)'
    );
    return { browser, mode: 'remote' };
  }

  const puppeteer = require('puppeteer');
  const browser = await withTimeout(
    puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
    }),
    30000,
    'Launching local Chrome via Puppeteer'
  );
  return { browser, mode: 'local' };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

async function dismissCookieBanner(page) {
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button'));
    for (const btn of candidates) {
      const t = (btn.innerText || '').toLowerCase();
      if (t.includes('autoriser') || t.includes('accepter') || t.includes('accept')) {
        btn.click();
        break;
      }
    }
  }).catch(() => {});
}

async function countUniqueListings(page, selector) {
  return page.evaluate((sel) => {
    const anchors = Array.from(document.querySelectorAll(sel));
    return new Set(anchors.map(a => a.href)).size;
  }, selector);
}

async function collectWithPagination(page, config, maxListings, maxPageClicks) {
  let previousCount = 0;
  let clicks = 0;

  page.on('console', msg => console.log(`[Barnes][page console] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => console.log(`[Barnes][page error] ${err.message}`));

  while (clicks < maxPageClicks) {
    const currentCount = await countUniqueListings(page, config.waitForSelector);

    console.log(`[Barnes] Unique listings on page: ${currentCount} (after ${clicks} click(s))`);

    if (currentCount >= maxListings) break;
    if (clicks > 0 && currentCount === previousCount) {
      console.log('[Barnes] No new listings after triggering "Next listings" — reached the end of real results.');
      break;
    }

    const nextButton = await page.$(config.nextPageSelector);
    if (!nextButton) {
      console.log('[Barnes] "Next listings" button not found — assuming all results already loaded.');
      break;
    }

    previousCount = currentCount;

    const calledDirectly = await page.evaluate(() => {
      if (typeof window.annonces_suivantes === 'function') {
        try {
          window.annonces_suivantes();
          return 'called';
        } catch (e) {
          return `threw: ${e.message}`;
        }
      }
      return 'not found on window';
    });
    console.log(`[Barnes] Direct function call result: ${calledDirectly}`);

    if (calledDirectly === 'not found on window') {
      console.log('[Barnes] Falling back to simulated click...');
      await nextButton.click().catch(e => console.log(`[Barnes] Click threw: ${e.message}`));
    }

    try {
      await page.waitForFunction(
        (sel, prev) => {
          const anchors = Array.from(document.querySelectorAll(sel));
          return new Set(anchors.map(a => a.href)).size > prev;
        },
        { timeout: 10000 },
        config.waitForSelector,
        previousCount
      );
    } catch (e) {
      console.log('[Barnes] Timed out waiting for more listings to load after triggering pagination.');
      break;
    }

    clicks++;
  }

  return page.evaluate(config.extract);
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

async function fetchListingDetails(browser, url, attempt = 1) {
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const bodyText = await page.evaluate(() => {
      const visible = document.body.innerText || '';
      const all = document.body.textContent || '';
      const spaced = all.replace(/([a-z])([A-Z])/g, '$1 $2');
      return visible + ' ' + spaced;
    });

    await page.close();
    return extractDetailFeatures(bodyText);
  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }

    if (attempt === 1) {
      console.log(`[Barnes] Detail fetch failed for ${url} (attempt 1): ${error.message} — retrying once...`);
      return fetchListingDetails(browser, url, 2);
    }

    console.log(`[Barnes] Detail fetch failed for ${url} (attempt 2, giving up): ${error.message}`);
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null };
  }
}

async function enrichWithDetails(browser, listings) {
  console.log(`[Barnes] Fetching detail pages for ${listings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
  const start = Date.now();
  let completed = 0;

  const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, async (listing) => {
    const result = await fetchListingDetails(browser, listing.url);
    completed++;
    if (completed % 10 === 0 || completed === listings.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[Barnes] Detail progress: ${completed}/${listings.length} (${elapsed}s elapsed)`);
    }
    return result;
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Barnes] Detail fetch complete in ${elapsed}s`);

  // FIXED: was `{ ...listing, ...details[i] }` — unconditionally
  // overwrote elevator/balcony/furnished with a failed fetch's nulls,
  // and left bathroomsFromDetail/bedroomsFromDetail stranded as unused
  // extra keys instead of merging them into bathrooms/bedrooms.
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

async function scrapeBarnes(searchType, options = {}) {
  // FIXED: defaulted to `true` — was `false`, meaning any caller that
  // forgot to explicitly opt in silently got zero furnished/elevator/
  // balcony data with no signal anything was wrong. A summary-card pass
  // (below) now always provides at least a baseline value regardless of
  // this flag; fetchDetails additionally enriches via the detail page.
  const { fetchDetails = true } = options;
  const { key, config } = getBarnesConfig(searchType);
  let browser;
  let page;

  try {
    const conn = await getBrowser();
    browser = conn.browser;
    console.log(`✅ Connected to browser (${conn.mode} mode)`);

    page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);

    console.log(`[${key}] Navigating to ${config.url}`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(err => {
      console.warn(`[${key}] Navigation warning: ${err.message}`);
    });

    await dismissCookieBanner(page);

    try {
      await page.waitForSelector(config.waitForSelector, { timeout: 15000 });
    } catch (e) {
      console.warn(`[${key}] Selector timeout ("${config.waitForSelector}")`);
    }

    try {
      await page.waitForFunction(
        () => typeof window.annonces_suivantes === 'function',
        { timeout: 15000 }
      );
    } catch (e) {
      console.warn('[Barnes] annonces_suivantes never became available on window within 15s — pagination will likely fail or fall back to a click.');
    }

    const maxListings = MAX_LISTINGS_BY_TYPE[config.searchType] || 200;
    const maxPageClicks = MAX_PAGE_CLICKS_BY_TYPE[config.searchType] || 15;

    const rawListings = await collectWithPagination(page, config, maxListings, maxPageClicks);
    console.log(`[${key}] Raw extracted (pre-filter): ${rawListings.length}`);

    const parsed = rawListings.slice(0, maxListings).map(item => {
      const listing = parseListing(item.rawText);
      // NEW — was completely missing before this fix. Runs on the
      // summary-card text already fetched above (no extra network cost),
      // giving every listing a baseline value even if the detail-page
      // enrichment below is skipped or partially fails.
      const details = extractDetailFeatures(item.rawText);
      listing.url = item.url;
      listing.source = 'Barnes';
      listing.searchType = config.searchType;
      listing.isExactListing = true;
      listing.elevator = details.elevator;
      listing.balcony = details.balcony;
      listing.furnished = details.furnished;
      if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
      if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
      return listing;
    });

    await page.close();

    const finalListings = fetchDetails
      ? await enrichWithDetails(browser, parsed)
      : parsed;

    if (browser.disconnect) await browser.disconnect();
    else await browser.close();

    return { source: 'Barnes', searchType: config.searchType, listings: finalListings, error: null };

  } catch (error) {
    console.error(`[Barnes] Error: ${error.message}`);
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) {
      try {
        if (browser.disconnect) await browser.disconnect();
        else await browser.close();
      } catch (e) {}
    }
    return { source: 'Barnes', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeBarnes };

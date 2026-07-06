// netlify/functions/scrape-runner.js
// Scoped to Barnes only. Handles the "Next listings" AJAX pagination
// (javascript:annonces_suivantes()) to reach up to MAX_LISTINGS before any
// price/room/etc. filtering happens — filtering is applied later, in
// search.js, on the full pulled set.

const { getBarnesConfig } = require('./source-config');
const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const MAX_LISTINGS = 100;
const MAX_PAGE_CLICKS = 10;
const DETAIL_FETCH_CONCURRENCY = 3; // keep modest — 100 detail pages is already a lot more load on Barnes than the fast path

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

// Wraps any promise with a hard timeout — used specifically for browser
// launch/connect, which had NO timeout protection before. Every other wait
// in this file (navigation, selectors, clicks) already had one; a hang
// during launch itself could previously run forever with nothing to catch
// it, only stopped by GitHub Actions' own 6-hour job ceiling.
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

// Clicks "Next listings" repeatedly until we hit MAX_LISTINGS, run out of
// new listings to load, or hit the safety click cap — whichever comes first.
//
// IMPORTANT: we count UNIQUE listing URLs, not raw querySelectorAll(...).length.
// Each listing on this site has multiple <a href="/ref-..."> tags pointing
// at the same URL (thumbnail images + title link), so a raw node count
// overcounts by roughly 4x. Live testing caught this: the loop was stopping
// after 1 click because raw count hit 104, while only ~24 *unique* listings
// had actually loaded. Counting unique hrefs matches what extract() itself
// dedupes down to, so the stopping condition and the final output agree.
async function countUniqueListings(page, selector) {
  return page.evaluate((sel) => {
    const anchors = Array.from(document.querySelectorAll(sel));
    return new Set(anchors.map(a => a.href)).size;
  }, selector);
}

async function collectWithPagination(page, config) {
  let previousCount = 0;
  let clicks = 0;

  // Diagnostics: surface anything the page itself logs or errors on,
  // since "the click did nothing" could mean several different things
  // (blocked by an overlay, a JS error, bot detection, etc.) and we need
  // to see which.
  page.on('console', msg => console.log(`[Barnes][page console] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => console.log(`[Barnes][page error] ${err.message}`));

  while (clicks < MAX_PAGE_CLICKS) {
    const currentCount = await countUniqueListings(page, config.waitForSelector);

    console.log(`[Barnes] Unique listings on page: ${currentCount} (after ${clicks} click(s))`);

    if (currentCount >= MAX_LISTINGS) break;
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

    // PRIMARY: call the underlying function directly. This is more
    // reliable than a simulated DOM click on a javascript: href, which
    // can silently no-op if an overlay is intercepting the click,
    // headless detection blocks it, or the click coordinates miss.
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

    // FALLBACK: if the function genuinely isn't reachable on window,
    // fall back to a real simulated click.
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

// Simple concurrency-limited map, same pattern used elsewhere in this
// codebase — runs at most `limit` fetches at a time so we don't hammer
// Barnes with 100 simultaneous requests.
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

// Visits ONE listing's detail page and extracts elevator/balcony/furnished.
// A failure here (page error, timeout, selector issue) must not crash the
// whole batch — it just leaves that listing's detail fields as null,
// which is visible and honest rather than silently wrong.
async function fetchListingDetails(browser, url, attempt = 1) {
  let page;
  try {
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Combine innerText (visible/rendered text) with textContent (includes
    // text hidden behind collapsed panels, e.g. a "show more" Amenities
    // section). innerText alone was confirmed to miss real data: a live
    // test returned furnished=null for a listing whose Amenities section
    // literally lists "Furnished" — almost certainly because that section
    // is collapsed by default and innerText only sees visible content.
    const bodyText = await page.evaluate(() => {
      const visible = document.body.innerText || '';
      const all = document.body.textContent || '';
      // Insert spaces at lowercase->uppercase boundaries so words that get
      // concatenated without whitespace when read via textContent (e.g. a
      // list rendered as "FreezerFurnishedHob") still separate into words
      // a \b-based regex can match individually.
      const spaced = all.replace(/([a-z])([A-Z])/g, '$1 $2');
      return visible + ' ' + spaced;
    });

    await page.close();
    return extractDetailFeatures(bodyText);
  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }

    // One retry — live testing showed ~20% of detail-page fetches failing
    // with transient errors ("frame detached", "Connection closed") when
    // running 100 in a row. A single retry with a fresh page recovers most
    // of these without much added time, since most failures are transient
    // rather than that specific page being permanently broken.
    if (attempt === 1) {
      console.log(`[Barnes] Detail fetch failed for ${url} (attempt 1): ${error.message} — retrying once...`);
      return fetchListingDetails(browser, url, 2);
    }

    console.log(`[Barnes] Detail fetch failed for ${url} (attempt 2, giving up): ${error.message}`);
    return { elevator: null, balcony: null, furnished: null };
  }
}

// Enriches an already-parsed listing array with detail-page data. This is
// the slow, opt-in step: visits every listing's own page (up to 100 extra
// page loads) rather than relying only on the fast results-list summary.
async function enrichWithDetails(browser, listings) {
  console.log(`[Barnes] Fetching detail pages for ${listings.length} listings (concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
  const start = Date.now();
  let completed = 0;

  const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, async (listing) => {
    const result = await fetchListingDetails(browser, listing.url);
    completed++;
    // Progress every 10 listings (or every one, if fewer than 10 total) so
    // a multi-minute run doesn't look frozen with no output.
    if (completed % 10 === 0 || completed === listings.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[Barnes] Detail progress: ${completed}/${listings.length} (${elapsed}s elapsed)`);
    }
    return result;
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[Barnes] Detail fetch complete in ${elapsed}s`);

  return listings.map((listing, i) => ({ ...listing, ...details[i] }));
}

async function scrapeBarnes(searchType, options = {}) {
  const { fetchDetails = false } = options;
  const { key, config } = getBarnesConfig(searchType);
  let browser;
  let page;

  try {
    const conn = await getBrowser();
    browser = conn.browser;
    console.log(`✅ Connected to browser (${conn.mode} mode)`);

    page = await browser.newPage();
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

    // domcontentloaded fires before async/deferred scripts (like whatever
    // defines annonces_suivantes) necessarily finish executing. Rather than
    // guessing at a navigation timing strategy that's either too slow
    // (networkidle2 — caused a real timeout) or too fast (domcontentloaded
    // alone — function not defined yet), wait for the ACTUAL thing we need.
    try {
      await page.waitForFunction(
        () => typeof window.annonces_suivantes === 'function',
        { timeout: 15000 }
      );
    } catch (e) {
      console.warn('[Barnes] annonces_suivantes never became available on window within 15s — pagination will likely fail or fall back to a click.');
    }

    const rawListings = await collectWithPagination(page, config);
    console.log(`[${key}] Raw extracted (pre-filter): ${rawListings.length}`);

    const parsed = rawListings.slice(0, MAX_LISTINGS).map(item => {
      const listing = parseListing(item.rawText);
      listing.url = item.url;
      listing.source = 'Barnes';
      listing.searchType = config.searchType;
      listing.isExactListing = true;
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

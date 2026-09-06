// belles-demeures-scraper.js
//
// NEW FILE. Belles Demeures — luxury listing portal owned by Digital
// Classifieds France, the SAME parent company as SeLoger (confirmed via
// its footer linking directly to seloger.com, and matching SeLoger's
// professional/URL conventions). This was flagged as a judgment call
// earlier in this project (given SeLoger itself was removed entirely
// for being unmanageable at scale) — added now on explicit request.
//
// VERIFIED LIVE (2026-09-05):
//   - Per-arrondissement rent URL:
//     https://www.bellesdemeures.com/location/france/ile-de-france/paris/paris-{Neme}/appartement-luxe/tt-1-tb-1-pl-{code}/
//     — confirmed for paris-5eme (pl-32585), paris-6eme (pl-32586),
//     paris-8eme (pl-32588), paris-16eme (pl-32596, 238 listings live),
//     paris-17eme (pl-32597). The numeric code is arrondissement-linear:
//     code = 32580 + arrondissement number (5->32585, 6->32586, 8->32588,
//     16->32596, 17->32597 all confirmed) — used to construct all 20
//     without needing to verify each individually. Arrondissement 1 is
//     assumed to use "paris-1er" (matching this codebase's convention
//     elsewhere) with code 32581 — NOT independently confirmed.
//   - Sale URL: same shape with tt-2 instead of tt-1 (confirmed via a
//     live English "/en/sale/.../tt-2-tb-1-pl-32596/" URL) — the French
//     "/vente/" equivalent is inferred by symmetry with "/location/",
//     not independently confirmed live.
//   - Pagination: numbered URL suffix, e.g. .../pl-32596/2/, .../pl-32596/4/
//     — confirmed live for multiple page numbers.
//   - Individual listing URL pattern: /annonces/location/tt-1-tb-1-pl-{code}/{id}/
//     (confirmed live) — matched via a[href*="/annonces/"].
//   - Given the confirmed 238-listing count for just the 16th
//     arrondissement alone, this is likely thousands of listings across
//     all 20 — same order of magnitude that made SeLoger's full removal
//     necessary earlier in this project. Built as its own isolated job
//     (see scrape-single-belles-demeures.js) with a real per-page cap
//     (not unbounded) specifically to avoid reproducing that problem.
//   - Uses puppeteer-extra + stealth given the confirmed SeLoger-family
//     origin — sibling sites in this family are known from this
//     project's own history to be difficult for a plain headless
//     browser.

const parseListing = require('./parse-listing');
const { extractDetailFeatures } = require('./parse-listing');

const ARR_COUNT = 20;
const PL_CODE_OFFSET = 32580; // code = 32580 + arrondissement number, confirmed for 5/6/8/16/17
const LISTING_SELECTOR = 'a[href*="/annonces/"]';
const MAX_PAGES_PER_ARR = 15; // safety cap — 238 listings / ~20 per page ≈ 12 pages for the busiest arrondissement (16th)
const DETAIL_FETCH_CONCURRENCY = 2;

function arrSlug(n) {
  return n === 1 ? '1er' : `${n}eme`;
}

function searchUrl(n, searchType) {
  const code = PL_CODE_OFFSET + n;
  const tt = searchType === 'sale' ? 'tt-2' : 'tt-1';
  const path = searchType === 'sale' ? 'vente' : 'location';
  return `https://www.bellesdemeures.com/${path}/france/ile-de-france/paris/paris-${arrSlug(n)}/appartement-luxe/${tt}-tb-1-pl-${code}/`;
}

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

async function dismissCookieBanner(page) {
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).forEach(btn => {
      const t = (btn.innerText || '').toLowerCase();
      if (t.includes('accepter') || t.includes('autoriser') || t.includes('tout accepter') || t.includes('accept')) btn.click();
    });
  }).catch(() => {});
}

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/annonces/"]'));
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
      elevator: d.elevator != null ? d.elevator : listing.elevator,
      balcony: d.balcony != null ? d.balcony : listing.balcony,
      furnished: d.furnished != null ? d.furnished : listing.furnished,
      bathrooms: listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail,
      bedrooms: listing.bedrooms != null ? listing.bedrooms : d.bedroomsFromDetail
    };
  });
}

async function scrapeBellesDemeures(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    const allListings = [];
    const seenUrls = new Set();

    for (let n = 1; n <= ARR_COUNT; n++) {
      for (let pageNum = 1; pageNum <= MAX_PAGES_PER_ARR; pageNum++) {
        const base = searchUrl(n, searchType);
        const url = pageNum === 1 ? base : `${base}${pageNum}/`;

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(20000);
        console.log(`[Belles Demeures] Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await dismissCookieBanner(page);

        try {
          await page.waitForSelector(LISTING_SELECTOR, { timeout: 15000 });
        } catch (e) {
          console.log(`[Belles Demeures] arr ${n}, page ${pageNum}: no listings — end of this arrondissement.`);
          await page.close();
          break;
        }

        const raw = await page.evaluate(extractListings);
        let newCount = 0;
        for (const item of raw) {
          if (seenUrls.has(item.url)) continue;
          seenUrls.add(item.url);
          allListings.push(item);
          newCount++;
        }
        console.log(`[Belles Demeures] arr ${n}, page ${pageNum}: ${raw.length} on page, ${newCount} new (running total ${allListings.length})`);
        await page.close();

        if (newCount === 0) break; // exhausted this arrondissement's pages
      }
    }

    console.log(`[Belles Demeures] Raw extracted across all arrondissements: ${allListings.length}`);

    const parsed = allListings.map(item => {
      const listing = parseListing(item.rawText);
      const details = extractDetailFeatures(item.rawText);
      listing.url = item.url;
      listing.source = 'Belles Demeures';
      listing.searchType = searchType;
      listing.isExactListing = true;
      if (listing.elevator == null) listing.elevator = details.elevator;
      if (listing.balcony == null) listing.balcony = details.balcony;
      if (listing.furnished == null) listing.furnished = details.furnished;
      if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
      if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
      return listing;
    });

    const finalListings = await enrichWithDetails(browser, parsed);
    await browser.close();
    console.log(`[Belles Demeures] Total unique listings: ${finalListings.length}`);

    return { source: 'Belles Demeures', searchType, listings: finalListings, error: null };
  } catch (error) {
    console.error(`[Belles Demeures] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Belles Demeures', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeBellesDemeures };

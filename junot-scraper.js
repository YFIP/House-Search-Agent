// junot-scraper.js
//
// FIX (this pass): live evidence (a real listing's detail page,
// junot.fr/fr/biens/87111662-paris-4e-hotel-de-ville) showed "Meublé" is
// NOT present in the summary card text at all — it only appears in the
// detail page's spec-icon row ("Ce qui nous séduit" section). The
// original verification note below ("Price/rooms/sqm/elevator/balcony
// all in the summary card — NO detail-page visits needed") was correct
// for elevator/balcony but never actually verified for furnished
// specifically, and turned out to be wrong for that one field — every
// Junot listing was showing furnished as "Not mentioned" in production.
// Added a minimal detail-page fetch, using the shared mergeFeature()
// helper so a failed detail fetch can't erase a value already found.
//
// BUDGET WARNING: this source can have ~50 locations and up to 849 real
// sale listings (per the header notes below). Every other source that
// added detail-page enrichment (DanielFeau, Barnes, Eiffel Housing,
// SeLoger) eventually needed to move OUT of the shared scrape-main
// 15-minute job into its own isolated GitHub Actions job to avoid
// silently timing out mid-enrichment. Junot should get the same
// treatment — see scrape-single-junot.js and the corresponding workflow
// job — rather than staying inside scrape-main-sources.js.
//
// VERIFIED LIVE (via web_fetch during research, not just assumed):
//   - https://www.junot.fr/fr/biens-immobiliers/louer/ile-de-france/paris
//     (all-Paris aggregate, 21 listings, no pagination)
//   - .../paris-6e, .../paris-17e (individual arrondissements, 2-4 listings each)
//   - .../neuilly-sur-seine (22 listings)
//   - .../asnieres-sur-seine (loads correctly, low/zero listings that day)
//   - Price/rooms/sqm/elevator/balcony all in the summary card — NO
//     detail-page visits needed for THOSE fields, unlike Barnes/SeLoger.
//     Furnished is the one exception — see fix note above.
//   - NO pagination anywhere, even at 21+ listings on one page — Junot's
//     current inventory is small enough to fit on a single page every time.
//
// NOT individually verified (constructed from the confirmed URL pattern +
// Junot's own site-defined town list, per user request to cover all
// suburbs, not just the few explicitly fetched above):
//   - The other ~48 Hauts-de-Seine/Yvelines town URLs below. Each follows
//     the identical, proven pattern, so this is a reasonable extrapolation
//     — but if a specific town's slug is wrong or that town has zero
//     current listings, the code below handles it gracefully (zero
//     results, not an error) rather than assuming it's broken.
//
// Run test-local.js style verification against a sample of these before
// fully trusting the suburb coverage — same practice as every other
// source in this project.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const LISTING_SELECTOR = 'a[href*="/fr/biens/"]';

function getBaseUrl(searchType) {
  const segment = searchType === 'sale' ? 'acheter' : 'louer';
  return `https://www.junot.fr/fr/biens-immobiliers/${segment}/ile-de-france/`;
}

const PARIS_SLUG = 'paris';

const HAUTS_DE_SEINE_SLUGS = [
  'asnieres-sur-seine', 'bois-colombes', 'boulogne-billancourt', 'clamart',
  'clichy', 'colombes', 'courbevoie', 'garches', 'issy-les-moulineaux',
  'la-garenne-colombes', 'levallois-perret', 'marnes-la-coquette', 'meudon',
  'nanterre', 'neuilly-sur-seine', 'puteaux', 'rueil-malmaison',
  'saint-cloud', 'sceaux', 'sevres', 'suresnes', 'vanves', 'vaucresson',
  'ville-d-avray'
];

const YVELINES_SLUGS = [
  'aigremont', 'bailly', 'bougival', 'chatou', 'crespieres',
  'croissy-sur-seine', 'feucherolles', 'fourqueux', 'la-celle-saint-cloud',
  'le-chesnay', 'le-chesnay-rocquencourt', 'le-mesnil-le-roi', 'le-pecq',
  'le-vesinet', 'louveciennes', 'maisons-laffitte', 'marly-le-roi', 'maule',
  'montesson', 'neauphle-le-chateau', 'noisy-le-roi', 'rambouillet',
  'saint-germain-en-laye', 'saint-nom-la-breteche', 'thoiry', 'versailles',
  'viroflay'
];

const ALL_SLUGS = [PARIS_SLUG, ...HAUTS_DE_SEINE_SLUGS, ...YVELINES_SLUGS];

const LOWERCASE_PARTICLES = new Set(['sur', 'en', 'la', 'le', 'les', 'de', 'des', 'du', 'et', "d'"]);
function slugToDisplayName(slug) {
  const words = slug.split('-');
  return words
    .map((w, i) => {
      if (i > 0 && LOWERCASE_PARTICLES.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('-');
}

const MAX_CONCURRENT = 4;
// Kept modest — visiting individual detail pages is new for this source
// and its anti-bot behavior at this rate hasn't been directly tested.
const DETAIL_FETCH_CONCURRENCY = 2;

async function getBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

function extractListings() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/fr/biens/"]'))
    .filter(l => !l.href.includes('pinterest.com'));

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

// NEW — visits ONE listing's detail page specifically to recover
// furnished status, which (unlike elevator/balcony) does not appear in
// the summary card. A failure here (timeout, error) returns nulls and
// must never crash the batch — mergeFeature() at the call site ensures
// a failed fetch can't erase the elevator/balcony values already found
// from the summary card.
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

// NEW — enriches every listing with its detail-page furnished status.
// Elevator/balcony are intentionally NOT overwritten here — those are
// already reliable straight from the summary card (confirmed live), so
// re-fetching them from the detail page would only add risk (a failed
// fetch) for no benefit. Only furnished and bathrooms/bedrooms (which
// the summary card doesn't reliably state either) get the detail-page
// treatment.
async function enrichWithFurnished(browser, listings) {
  if (listings.length === 0) return listings;
  const details = await mapWithConcurrency(listings, DETAIL_FETCH_CONCURRENCY, (listing) =>
    fetchListingDetails(browser, listing.url)
  );
  return listings.map((listing, i) => {
    const d = details[i];
    return {
      ...listing,
      furnished: mergeFeature(d.furnished, listing.furnished),
      bathrooms: listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail,
      bedrooms: listing.bedrooms != null ? listing.bedrooms : d.bedroomsFromDetail
    };
  });
}

async function scrapeLocation(browser, slug, searchType) {
  let page;
  try {
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    const url = getBaseUrl(searchType) + slug;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    try {
      await page.waitForSelector(LISTING_SELECTOR, { timeout: 8000 });
    } catch (e) {
      await page.close();
      return { slug, listings: [], error: null };
    }

    if (searchType === 'sale') {
      const MAX_SCROLLS = 6;
      let previousCount = (await page.evaluate(extractListings)).length;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 5000));
        const currentCount = (await page.evaluate(extractListings)).length;
        if (currentCount <= previousCount) break;
        previousCount = currentCount;
      }
    }

    const raw = await page.evaluate(extractListings);
    await page.close();
    return { slug, listings: raw, error: null };

  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    return { slug, listings: [], error: error.message };
  }
}

async function scrapeJunot(searchType = 'rent') {
  let browser;
  try {
    browser = await getBrowser();
    console.log(`[Junot] Scraping ${ALL_SLUGS.length} locations (Paris + ${HAUTS_DE_SEINE_SLUGS.length + YVELINES_SLUGS.length} suburb towns)...`);

    let completed = 0;
    const start = Date.now();
    const results = await mapWithConcurrency(ALL_SLUGS, MAX_CONCURRENT, async (slug) => {
      const result = await scrapeLocation(browser, slug, searchType);
      completed++;
      if (completed % 10 === 0 || completed === ALL_SLUGS.length) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`[Junot] Progress: ${completed}/${ALL_SLUGS.length} locations (${elapsed}s elapsed)`);
      }
      return result;
    });

    const allListings = [];
    const failedSlugs = [];
    let zeroResultCount = 0;

    for (const r of results) {
      if (r.error) {
        failedSlugs.push(`${r.slug} (${r.error})`);
        continue;
      }
      if (r.listings.length === 0) {
        zeroResultCount++;
        continue;
      }
      const knownAddress = r.slug === PARIS_SLUG ? null : slugToDisplayName(r.slug);
      for (const item of r.listings) {
        const listing = parseListing(item.rawText);
        // Junot's summary card already includes "Ascenseur"/"Balcon" as
        // direct tags — confirmed working, no separate detail-page
        // visit needed for those two fields.
        const details = extractDetailFeatures(item.rawText);
        listing.url = item.url;
        listing.source = 'Junot';
        listing.searchType = searchType;
        listing.isExactListing = true;
        listing.elevator = details.elevator;
        listing.balcony = details.balcony;
        // NOT setting listing.furnished here anymore — "Meublé" isn't in
        // the summary card (confirmed live). Left null for now;
        // enrichWithFurnished() below fills it from the detail page.
        listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (listing.bedrooms == null) listing.bedrooms = details.bedroomsFromDetail;
        if (knownAddress) listing.address = knownAddress;
        allListings.push(listing);
      }
    }

    console.log(`[Junot] Total listings before furnished enrichment: ${allListings.length}`);
    console.log(`[Junot] Locations with zero current listings: ${zeroResultCount}/${ALL_SLUGS.length}`);
    if (failedSlugs.length > 0) {
      console.log(`[Junot] Failed locations: ${failedSlugs.join(', ')}`);
    }

    console.log(`[Junot] Fetching detail pages for furnished status (${allListings.length} listings, concurrency: ${DETAIL_FETCH_CONCURRENCY})...`);
    const enrichedListings = await enrichWithFurnished(browser, allListings);

    await browser.close();
    console.log(`[Junot] Total listings: ${enrichedListings.length}`);

    return {
      source: 'Junot',
      searchType,
      listings: enrichedListings,
      error: null,
      diagnostics: { zeroResultCount, failedSlugs }
    };

  } catch (error) {
    console.error(`[Junot] Fatal error: ${error.message}`);
    if (browser) { try { await browser.close(); } catch (e) {} }
    return { source: 'Junot', searchType, listings: [], error: error.message };
  }
}

module.exports = { scrapeJunot, ALL_SLUGS };

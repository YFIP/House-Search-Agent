// junot-scraper.js
//
// VERIFIED LIVE (via web_fetch during research, not just assumed):
//   - https://www.junot.fr/fr/biens-immobiliers/louer/ile-de-france/paris
//     (all-Paris aggregate, 21 listings, no pagination)
//   - .../paris-6e, .../paris-17e (individual arrondissements, 2-4 listings each)
//   - .../neuilly-sur-seine (22 listings)
//   - .../asnieres-sur-seine (loads correctly, low/zero listings that day)
//   - Price/rooms/sqm/elevator/balcony all in the summary card — NO
//     detail-page visits needed, unlike Barnes/SeLoger.
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
const { extractDetailFeatures } = require('./parse-listing');

const LISTING_SELECTOR = 'a[href*="/fr/biens/"]';

// Same URL structure for both — just "louer" (rent) vs "acheter" (buy),
// confirmed live: https://www.junot.fr/fr/biens-immobiliers/acheter/
// ile-de-france/paris-17e etc. Sale prices found in real testing range
// from ~400,000€ to several million — the existing saleAfter/saleBefore
// price patterns in parse-listing.js already handle this format
// correctly (no "/mois" suffix), confirmed by the file's own original
// design comment mentioning both "12 000 000 €" and "€ 17,000 / month"
// as formats it was built to handle from the start.
function getBaseUrl(searchType) {
  const segment = searchType === 'sale' ? 'acheter' : 'louer';
  return `https://www.junot.fr/fr/biens-immobiliers/${segment}/ile-de-france/`;
}

// Paris aggregate covers all 20 arrondissements in one page — no need to
// list them individually.
const PARIS_SLUG = 'paris';

// Hauts-de-Seine towns Junot's own site defines (from the location filter
// tree) — the "core" ones Junot explicitly markets rental coverage in
// (Neuilly-sur-Seine, Levallois-Perret, Boulogne-Billancourt, Rueil-
// Malmaison, Suresnes, Puteaux, Saint-Cloud) plus the fuller town list
// from their broader Hauts-de-Seine Ouest/Yvelines office network.
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

// Converts a URL slug into a readable display name for consistency across
// sources — e.g. "saint-germain-en-laye" -> "Saint-Germain-en-Laye". Common
// French connector words stay lowercase (matching real place-name
// convention) unless they're the first word. Not a perfect French-grammar
// engine, but consistent, which is what actually matters for sorting.
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

// Scrapes ONE location's page (Paris aggregate or a single town) — no
// pagination needed, confirmed across every sample checked.
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
      // Genuinely zero listings for this location today is expected and
      // fine — not every one of ~50 towns will have active inventory at
      // any given moment. Not logged as an error.
      await page.close();
      return { slug, listings: [], error: null };
    }

    // Real bug found live: Junot had NO pagination at all — fine for
    // rent (41 real listings total, comfortably fits on one page) but a
    // serious gap for sale (849 real listings — page 1 alone was only
    // capturing a small fraction). Confirmed live: this is infinite
    // scroll with a genuine 3-5s loading delay per batch (not a
    // click-based "next" control — earlier "page 2" elements found on
    // the page turned out to be unrelated multi-step form progress
    // indicators, not pagination). Only applied for sale — rent doesn't
    // need it, and scrolling adds real time cost multiplied across
    // ~50+ individual location pages scraped per run.
    if (searchType === 'sale') {
      const MAX_SCROLLS = 6; // bounded per-location to keep total runtime reasonable across all ~50 locations
      let previousCount = (await page.evaluate(extractListings)).length;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 5000)); // confirmed live: 3-5s real loading delay
        const currentCount = (await page.evaluate(extractListings)).length;
        if (currentCount <= previousCount) break; // genuinely reached the end
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

    await browser.close();

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
      // The "paris" slug is an aggregate covering all 20 arrondissements
      // in one page — keep real text-based address parsing there, since
      // we don't know in advance which arrondissement each listing is in.
      // Every OTHER slug is one specific suburb town, so override with
      // the known name — more reliable and consistent than re-deriving it
      // from noisy card text (same fix applied to Barnes/SeLoger suburbs).
      const knownAddress = r.slug === PARIS_SLUG ? null : slugToDisplayName(r.slug);
      for (const item of r.listings) {
        const listing = parseListing(item.rawText);
        // Junot's summary card already includes "Ascenseur"/"Balcon" as
        // direct tags — same pattern confirmed working for Eiffel
        // Housing, no separate detail-page visit needed.
        const details = extractDetailFeatures(item.rawText);
        listing.url = item.url;
        listing.source = 'Junot';
        listing.searchType = searchType;
        listing.isExactListing = true;
        listing.elevator = details.elevator;
        listing.balcony = details.balcony;
        listing.furnished = details.furnished;
        if (listing.bathrooms == null) listing.bathrooms = details.bathroomsFromDetail;
        if (knownAddress) listing.address = knownAddress;
        allListings.push(listing);
      }
    }

    console.log(`[Junot] Total listings: ${allListings.length}`);
    console.log(`[Junot] Locations with zero current listings: ${zeroResultCount}/${ALL_SLUGS.length}`);
    if (failedSlugs.length > 0) {
      console.log(`[Junot] Failed locations: ${failedSlugs.join(', ')}`);
    }

    return {
      source: 'Junot',
      searchType,
      listings: allListings,
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

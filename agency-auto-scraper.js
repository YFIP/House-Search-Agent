// agency-auto-scraper.js
//
// NEW FILE (2026-11-07). A shared, self-discovering scraper used for the
// batch of agencies Anna and Analea sent on 6 Nov 2026 (see
// new-agencies-config.js).
//
// WHY A SHARED SCRAPER INSTEAD OF ONE HAND-TUNED FILE PER AGENCY:
// Every existing *-scraper.js file was written after inspecting that
// agency's live HTML (exact link selector, exact page-2 URL). These 13
// sites have NOT been inspected yet, so hard-coding selectors would be
// guessing. Instead this scraper works out, on the live page:
//   1. WHERE the rent / sale listings are — the configured URL if we
//      have one, otherwise by scanning the homepage nav for links like
//      "Louer", "Location", "Rent" / "Acheter", "Vente", "Buy".
//   2. WHICH links are listings — any same-site link whose surrounding
//      card contains a € price AND a surface / rooms / bedrooms figure
//      (unless a `listingSelector` override is configured).
//   3. HOW to get more — clicks "load more"-style buttons, scrolls for
//      infinite scroll, then follows rel="next" / "Suivant" / next page
//      number links, falling back to ?page=N and /page/N/ templates.
//
// Every run records what it discovered in a `debug` block (resolved URL,
// pages visited, how pagination was found, sample card text). That ends
// up in the output-new-agencies*.json artifact, so if an agency comes
// back with 0 or odd listings, the artifact says why — and once a site
// has been checked, a `listingSelector` / explicit URL can be pinned in
// new-agencies-config.js, or the agency can graduate to its own
// hand-tuned scraper file like the others.

const parseListing = require('./parse-listing');
const { extractDetailFeatures, mergeFeature } = require('./parse-listing');

const DEFAULTS = {
  maxPages: 15,              // safety cap on pagination
  maxListings: 300,          // safety cap per agency per search type
  maxLoadMoreClicks: 15,
  detailConcurrency: 2,
  maxDetailFetches: 150,     // keep CI time predictable
  navTimeoutMs: 25000,
};

const RENT_KEYWORDS = ['louer', 'location', 'locations', 'rent', 'rental', 'rentals', 'a-louer', 'meuble', 'furnished'];
const SALE_KEYWORDS = ['acheter', 'achat', 'vente', 'ventes', 'vendre-acheter', 'buy', 'sale', 'for-sale', 'a-vendre'];
const SALE_EXCLUDE = ['vendre', 'estimation', 'estimer', 'sell', 'valuation']; // "sell your home" pages, not listings

async function getBrowser() {
  let puppeteer;
  try {
    // Stealth plugin is already a dependency (Eiffel Housing / Belles
    // Demeures use it) — several of these agencies sit behind basic bot
    // protection, so use it when available.
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch (e) {
    puppeteer = require('puppeteer');
  }
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function openPage(browser, url, opts) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(opts.navTimeoutMs);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.navTimeoutMs })
    .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs }).catch(() => {}));
  await dismissCookieBanner(page);
  return page;
}

// Cookie walls (Axeptio, Didomi, OneTrust, Tarteaucitron...) can cover
// the listings or block "load more" clicks. Best-effort accept.
async function dismissCookieBanner(page) {
  try {
    await page.evaluate(() => {
      const labels = /^(tout accepter|accepter( tout)?|j'accepte|accept( all)?|ok|d'accord|allow all|agree)$/i;
      const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [class*="accept"], #didomi-notice-agree-button, #onetrust-accept-btn-handler, #tarteaucitronPersonalize2, #axeptio_btn_acceptAll'));
      const btn = buttons.find(b => labels.test((b.innerText || b.textContent || '').trim())) ||
                  buttons.find(b => /didomi-notice-agree|onetrust-accept|tarteaucitronPersonalize2|axeptio_btn_acceptAll/.test(b.id || ''));
      if (btn) btn.click();
    });
    await sleep(500);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// 1. Find the rent / sale listings page from a homepage
// ---------------------------------------------------------------------------
async function discoverSearchUrl(browser, baseUrl, searchType, opts) {
  const page = await openPage(browser, baseUrl, opts);
  try {
    const candidates = await page.evaluate((keywords, exclude) => {
      const host = location.hostname.replace(/^www\./, '');
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        let u;
        try { u = new URL(a.href, location.href); } catch (e) { continue; }
        if (u.hostname.replace(/^www\./, '') !== host) continue;
        const text = (a.innerText || a.textContent || '').trim().toLowerCase();
        const path = decodeURIComponent(u.pathname + u.search).toLowerCase();
        const hay = `${text} ${path}`;
        if (exclude.some(x => new RegExp(`\\b${x}\\b`).test(text) && !/acheter|achat|buy/.test(text))) continue;
        let score = 0;
        for (const k of keywords) {
          if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(text)) score += 3;
          if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(path)) score += 2;
        }
        if (!score) continue;
        if (/paris/.test(hay)) score += 1;
        if (/(blog|actualit|news|conseil|guide|faq|contact|mentions|recrut)/.test(path)) score -= 4;
        if (text.length > 60) score -= 2; // long text = article/teaser, not a nav link
        out.push({ href: u.href.split('#')[0], text: text.slice(0, 60), score });
      }
      return out;
    }, searchType === 'sale' ? SALE_KEYWORDS : RENT_KEYWORDS, SALE_EXCLUDE);
    await page.close();
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates.find(c => c.score >= 3);
    return { url: best ? best.href : null, candidates: candidates.slice(0, 5) };
  } catch (e) {
    try { await page.close(); } catch (_) {}
    return { url: null, candidates: [], error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 2. Pull listing cards off a results page (runs in the browser)
// ---------------------------------------------------------------------------
function extractListingsInPage(listingSelector, searchPageUrl) {
  const host = location.hostname.replace(/^www\./, '');
  const searchPath = new URL(searchPageUrl, location.href).pathname.replace(/\/$/, '');
  const PRICE = /\d[\d\s  .,]*\s*€|€\s*\d/;
  const SPECS = /\d+(?:[.,]\d+)?\s*(?:m²|m2|sqm)|\d+\s*(?:pi[eè]ces?|chambres?|bedrooms?|rooms?|p\.)\b|\bT\d\b|\bstudio\b/i;
  const NOT_LISTING = /\/(contact|blog|actualites?|news|agence|agences|equipe|team|mentions|cgu|cgv|privacy|cookies?|estimation|estimer|vendre|sell|recrutement|faq|login|connexion-client|compte|account|favoris|wishlist)(\/|$)|\.(pdf|jpe?g|png)$/i;

  const anchors = listingSelector
    ? Array.from(document.querySelectorAll(listingSelector)).map(el => el.closest('a[href]') || el.querySelector('a[href]') || el).filter(a => a && a.href)
    : Array.from(document.querySelectorAll('a[href]'));

  const byUrl = new Map();
  for (const a of anchors) {
    let u;
    try { u = new URL(a.href, location.href); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, '') !== host && !listingSelector) continue;
    u.hash = '';
    const path = u.pathname.replace(/\/$/, '');
    if (!listingSelector) {
      if (path === searchPath || path === '' || NOT_LISTING.test(u.pathname)) continue;
      // Pagination / filter links point back at the search page itself.
      if (path === searchPath && u.search) continue;
      if (/[?&](page|p|paged|pg)=\d+/i.test(u.search) && path === searchPath) continue;
    }
    const href = u.href;

    // Walk up to the smallest ancestor that looks like a whole card: has
    // a price and a spec, but isn't a container of many listings.
    let container = a;
    let text = '';
    for (let i = 0; i < 8 && container; i++) {
      text = (container.innerText || '').replace(/[ \t]+/g, ' ').trim();
      if (PRICE.test(text) && (SPECS.test(text) || listingSelector)) break;
      container = container.parentElement;
    }
    if (!container || !PRICE.test(text)) continue;
    if (!listingSelector && !SPECS.test(text)) continue;
    // A container holding several prices is a whole results grid, not a card.
    const priceCount = (text.match(/€/g) || []).length;
    if (priceCount > 3 || text.length > 1500) continue;

    const prev = byUrl.get(href);
    if (!prev || text.length > prev.rawText.length) byUrl.set(href, { url: href, rawText: text.slice(0, 600) });
  }
  return Array.from(byUrl.values());
}

// ---------------------------------------------------------------------------
// 3. Pagination helpers
// ---------------------------------------------------------------------------
async function clickLoadMoreUntilDone(page, opts) {
  let clicks = 0;
  for (; clicks < opts.maxLoadMoreClicks; clicks++) {
    const clicked = await page.evaluate(() => {
      const re = /^(voir|charger|afficher)\s+(plus|davantage|la suite)|plus de (biens|résultats|annonces)|load more|show more|see more|more (properties|listings|results)|annonces suivantes|next listings/i;
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const btn = els.find(el => re.test((el.innerText || el.textContent || '').trim()) && el.offsetParent !== null);
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }).catch(() => false);
    if (!clicked) break;
    await sleep(1800 + Math.random() * 800);
  }
  return clicks;
}

async function scrollToBottom(page) {
  let lastHeight = 0;
  for (let i = 0; i < 8; i++) {
    const height = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; }).catch(() => 0);
    if (height === lastHeight) break;
    lastHeight = height;
    await sleep(1200);
  }
}

async function findNextPageUrl(page, pageNum) {
  return page.evaluate((next) => {
    const visible = el => el.offsetParent !== null || el.getClientRects().length > 0;
    const usable = a => a && a.href && !/^javascript:|#$/.test(a.getAttribute('href') || '') && a.href !== location.href;
    const relNext = document.querySelector('a[rel="next"], link[rel="next"]');
    if (relNext && relNext.href && relNext.href !== location.href) return { url: relNext.href, how: 'rel=next' };
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter(visible);
    const byText = anchors.find(a => usable(a) && /^(suivant(e)?|page suivante|next( page)?|›|»|>|→)$/i.test((a.innerText || a.getAttribute('aria-label') || a.title || '').trim()));
    if (byText) return { url: byText.href, how: 'next-text' };
    const byAria = anchors.find(a => usable(a) && /suivant|next/i.test(`${a.getAttribute('aria-label') || ''} ${a.className || ''}`));
    if (byAria) return { url: byAria.href, how: 'next-aria/class' };
    const byNumber = anchors.find(a => usable(a) && (a.innerText || '').trim() === String(next) && /page|[?&]p=|paged|pg=|\/\d+\/?$/i.test(a.href));
    if (byNumber) return { url: byNumber.href, how: 'page-number' };
    return null;
  }, pageNum + 1).catch(() => null);
}

function templatedPageUrls(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  const q = new URL(baseUrl); q.searchParams.set('page', String(pageNum));
  const pathStyle = new URL(baseUrl);
  pathStyle.pathname = `${u.pathname.replace(/\/$/, '')}/page/${pageNum}/`;
  return [q.href, pathStyle.href];
}

// ---------------------------------------------------------------------------
// 4. Detail-page enrichment (same approach as the existing scrapers)
// ---------------------------------------------------------------------------
async function fetchListingDetails(browser, url, opts, isRetry = false) {
  let page;
  try {
    await sleep(400 + Math.random() * 400);
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    await page.close();
    if (bodyText.length < 500 && !isRetry) {
      await sleep(3000 + Math.random() * 2000);
      return fetchListingDetails(browser, url, opts, true);
    }
    return { ...extractDetailFeatures(bodyText), bodyText: bodyText.slice(0, 4000) };
  } catch (error) {
    if (page) { try { await page.close(); } catch (e) {} }
    return { elevator: null, balcony: null, furnished: null, bathroomsFromDetail: null, bedroomsFromDetail: null, bodyText: '' };
  }
}

async function enrichWithDetails(browser, listings, opts) {
  const toEnrich = listings.slice(0, opts.maxDetailFetches);
  const details = await mapWithConcurrency(toEnrich, opts.detailConcurrency, l => fetchListingDetails(browser, l.url, opts));
  return listings.map((listing, i) => {
    const d = details[i];
    if (!d) return listing;
    const fromDetail = d.bodyText ? parseListing(d.bodyText) : {};
    return {
      ...listing,
      // Cards on some sites omit price/size/area — fill gaps from the detail page.
      price: listing.price || fromDetail.price || listing.price,
      sqm: listing.sqm != null ? listing.sqm : fromDetail.sqm,
      // parse-listing falls back to raw card text when a card has no real
      // address; prefer the detail page's when only it names Paris/a postcode.
      address: (!/paris|\b7[5789]\d{3}\b|\b9[1-5]\d{3}\b/i.test(listing.address || '') && /paris|\b7[5789]\d{3}\b|\b9[1-5]\d{3}\b/i.test(fromDetail.address || ''))
        ? fromDetail.address
        : (listing.address || fromDetail.address || ''),
      elevator: mergeFeature(d.elevator, listing.elevator),
      balcony: mergeFeature(d.balcony, listing.balcony),
      furnished: mergeFeature(d.furnished, listing.furnished),
      bathrooms: listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail,
      bedrooms: listing.bedrooms != null ? listing.bedrooms : d.bedroomsFromDetail
    };
  });
}

// ---------------------------------------------------------------------------
// Rent vs sale sanity check. Several of these agencies list both on one
// page or link rentals from the sale menu. Rent is monthly, sale is a
// purchase price — the two ranges barely overlap in Paris.
// ---------------------------------------------------------------------------
function looksLikeSearchType(listing, rawText, searchType) {
  const monthly = /\/\s*(mois|month)|par mois|per month|mensuel|\bcc\b|\bhc\b|charges comprises|hors charges|loyer/i.test(rawText);
  if (searchType === 'rent') {
    if (monthly) return true;
    return !(listing.price && listing.price > 40000);
  }
  if (monthly) return false;
  return !(listing.price && listing.price < 40000);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
function createAgencyScraper(agency) {
  const opts = { ...DEFAULTS, ...(agency.options || {}) };
  const tag = `[${agency.source}]`;

  return async function scrape(searchType = 'rent', injected = {}) {
    const debug = { searchType, resolvedUrl: null, urlFrom: null, pages: [], discovery: null, droppedWrongType: 0, samples: [] };
    if (searchType === 'rent' && agency.saleOnly) return { source: agency.source, searchType, listings: [], error: null, skipped: 'sale-only agency', debug };
    if (searchType === 'sale' && agency.rentOnly) return { source: agency.source, searchType, listings: [], error: null, skipped: 'rent-only agency', debug };

    let browser;
    try {
      browser = injected.browser || await getBrowser();

      // ---- 1. Where are the listings? -----------------------------------
      let searchUrl = searchType === 'sale' ? agency.saleUrl : agency.rentUrl;
      debug.urlFrom = searchUrl ? 'config' : null;
      if (!searchUrl) {
        const found = await discoverSearchUrl(browser, agency.baseUrl, searchType, opts);
        debug.discovery = found;
        searchUrl = found.url;
        debug.urlFrom = searchUrl ? 'discovered-from-homepage' : null;
      }
      if (!searchUrl) {
        console.log(`${tag} No ${searchType} page found on ${agency.baseUrl} — treating as none for this agency.`);
        if (!injected.browser) await browser.close();
        return { source: agency.source, searchType, listings: [], error: null, skipped: `no ${searchType} page found`, debug };
      }
      debug.resolvedUrl = searchUrl;

      // ---- 2 & 3. Walk the result pages ------------------------------------
      const seen = new Set();
      const listings = [];
      let pageUrl = searchUrl;
      const visited = new Set();
      let templateIndex = null; // which ?page= / /page/N/ template worked, once known

      for (let pageNum = 1; pageNum <= opts.maxPages && pageUrl && listings.length < opts.maxListings; pageNum++) {
        if (visited.has(pageUrl)) break;
        visited.add(pageUrl);
        console.log(`${tag} ${searchType} page ${pageNum}: ${pageUrl}`);
        const page = await openPage(browser, pageUrl, opts);
        const loadMoreClicks = pageNum === 1 ? await clickLoadMoreUntilDone(page, opts) : 0;
        await scrollToBottom(page);
        const raw = await page.evaluate(extractListingsInPage, agency.listingSelector || null, searchUrl).catch(() => []);

        let added = 0;
        for (const item of raw) {
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          const listing = parseListing(item.rawText);
          if (!looksLikeSearchType(listing, item.rawText, searchType)) { debug.droppedWrongType++; continue; }
          const d = extractDetailFeatures(item.rawText);
          Object.assign(listing, {
            url: item.url,
            source: agency.source,
            searchType,
            isExactListing: true,
            elevator: listing.elevator != null ? listing.elevator : d.elevator,
            balcony: listing.balcony != null ? listing.balcony : d.balcony,
            furnished: listing.furnished != null ? listing.furnished : (agency.allFurnished ? true : d.furnished),
            bathrooms: listing.bathrooms != null ? listing.bathrooms : d.bathroomsFromDetail,
            bedrooms: listing.bedrooms != null ? listing.bedrooms : d.bedroomsFromDetail,
          });
          listings.push(listing);
          if (debug.samples.length < 3) debug.samples.push(item.rawText.slice(0, 300));
          added++;
        }

        // Find the next page.
        let next = await findNextPageUrl(page, pageNum);
        await page.close();
        const pageInfo = { pageNum, url: pageUrl, rawCards: raw.length, added, loadMoreClicks, next: next ? next.how : null };
        debug.pages.push(pageInfo);

        if (added === 0) break;
        if (next && !visited.has(next.url)) { pageUrl = next.url; continue; }

        // No visible pager — try the common URL templates. On page 1 we
        // don't know which (if any) the site uses, so test both.
        const templates = templatedPageUrls(searchUrl, pageNum + 1);
        if (templateIndex !== null) { pageUrl = templates[templateIndex]; continue; }
        pageUrl = null;
        for (let t = 0; t < templates.length; t++) {
          const probe = await openPage(browser, templates[t], opts);
          const probeRaw = await probe.evaluate(extractListingsInPage, agency.listingSelector || null, searchUrl).catch(() => []);
          await probe.close();
          if (probeRaw.some(r => !seen.has(r.url))) { templateIndex = t; pageUrl = templates[t]; pageInfo.next = `template:${t === 0 ? '?page=N' : '/page/N/'}`; break; }
        }
      }

      // ---- 4. Enrich from detail pages ------------------------------------
      console.log(`${tag} ${listings.length} ${searchType} listings — fetching detail pages (max ${opts.maxDetailFetches})...`);
      const enriched = injected.skipDetails ? listings : await enrichWithDetails(browser, listings, opts);

      if (!injected.browser) await browser.close();
      console.log(`${tag} Done: ${enriched.length} ${searchType} listings`);
      return { source: agency.source, searchType, listings: enriched, error: null, debug };
    } catch (error) {
      console.error(`${tag} Fatal error: ${error.message}`);
      if (browser && !injected.browser) { try { await browser.close(); } catch (e) {} }
      return { source: agency.source, searchType, listings: [], error: error.message, debug };
    }
  };
}

module.exports = { createAgencyScraper, extractListingsInPage, looksLikeSearchType, templatedPageUrls };

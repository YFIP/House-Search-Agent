// netlify/functions/source-config.js
// Scoped down to Barnes only while we get pagination + rent/buy fully right.
// searchType is REQUIRED — this config only exposes one Barnes "source" per
// type, so a caller must pick which one they want. No default/fallback URL,
// since guessing rent-vs-buy silently was part of what caused problems
// before (search.js used to accept searchType but never actually used it
// to pick a URL).
//
// Both URLs below were verified live and are Paris-scoped (not France-wide,
// not worldwide):
//   Rent: https://www.barnes-international.com/en/for-rent/france/paris.html  (146 listings)
//   Buy:  https://www.barnes-international.com/en/for-sale/france/paris.html (938 listings)
//
// Both use the same pagination mechanism: a "Next listings" link running
// javascript:annonces_suivantes(), which AJAX-appends more cards to the
// same page rather than navigating. scrape-runner.js handles the clicking;
// this config just needs to expose the button's selector.

const SCRAPER_CONFIG = {
  Barnes_Rent: {
    searchType: 'rent',
    url: 'https://www.barnes-international.com/en/for-rent/france/paris.html',
    waitForSelector: 'a[href*="/ref-"]',
    nextPageSelector: 'a[href^="javascript:annonces_suivantes"]',
    extract: () => {
      const results = [];
      const seen = new Set();
      // Filter to /france/ in the path — Barnes is a global luxury agency,
      // and the same /ref-XXX.html URL pattern is used site-wide for EVERY
      // country's listings, not just France. Without this filter, real
      // evidence showed Dubai, Athens, London, Madrid, Budapest, and other
      // international listings bleeding into what should be a Paris-only
      // scrape (likely from a "you might also like" worldwide carousel on
      // the page).
      const links = Array.from(document.querySelectorAll('a[href*="/ref-"]'))
        .filter(l => l.href.includes('/france/paris')); // tightened from '/france/' after finding Marseille/Lyon/Lille (other French cities) also bleeding in via the same carousel

      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);

        let container = link;
        let text = '';
        for (let i = 0; i < 6; i++) {
          container = container.parentElement;
          if (!container) break;
          text = container.innerText || '';
          if (text.includes('€')) break;
        }

        if (text.includes('€')) {
          results.push({ url: href, rawText: text.slice(0, 400) });
        }
      }

      return results;
    }
  },

  Barnes_Buy: {
    searchType: 'purchase',
    url: 'https://www.barnes-international.com/en/for-sale/france/paris.html',
    waitForSelector: 'a[href*="/ref-"]',
    nextPageSelector: 'a[href^="javascript:annonces_suivantes"]',
    extract: () => {
      const results = [];
      const seen = new Set();
      // Filter to /france/ in the path — Barnes is a global luxury agency,
      // and the same /ref-XXX.html URL pattern is used site-wide for EVERY
      // country's listings, not just France. Without this filter, real
      // evidence showed Dubai, Athens, London, Madrid, Budapest, and other
      // international listings bleeding into what should be a Paris-only
      // scrape (likely from a "you might also like" worldwide carousel on
      // the page).
      const links = Array.from(document.querySelectorAll('a[href*="/ref-"]'))
        .filter(l => l.href.includes('/france/paris')); // tightened from '/france/' after finding Marseille/Lyon/Lille (other French cities) also bleeding in via the same carousel

      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);

        let container = link;
        let text = '';
        for (let i = 0; i < 6; i++) {
          container = container.parentElement;
          if (!container) break;
          text = container.innerText || '';
          if (text.includes('€')) break;
        }

        if (text.includes('€')) {
          results.push({ url: href, rawText: text.slice(0, 400) });
        }
      }

      return results;
    }
  },
};

// Helper: given a desired searchType ('rent' | 'purchase'), return the
// matching Barnes config. Throws rather than silently defaulting — a
// caller must be explicit, since implicit rent-only was the whole bug.
function getBarnesConfig(searchType) {
  const key = searchType === 'purchase' ? 'Barnes_Buy' : searchType === 'rent' ? 'Barnes_Rent' : null;
  if (!key) {
    throw new Error(`searchType must be 'rent' or 'purchase', got: ${JSON.stringify(searchType)}`);
  }
  return { key, config: SCRAPER_CONFIG[key] };
}

module.exports = { SCRAPER_CONFIG, getBarnesConfig };

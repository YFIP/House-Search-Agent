// Per-source scraper configuration.
//
// Each entry describes ONE agency website: its listing-search URL, and a
// function that knows how to extract listings from that specific site's
// HTML structure. This is the only place that needs to change when:
//   - adding a new source to scrape
//   - fixing a source whose site layout changed
//
// The actual browser automation (connecting to Catalyst, navigating,
// waiting, retrying) lives in scrape-runner.js and is shared by every
// source — it never needs to change just because a site's HTML changed.
//
// HOW TO ADD A NEW SOURCE:
//   1. Add a new key to SCRAPER_CONFIG below, named exactly like the
//      source name used elsewhere in Prospector (index.html's
//      ALL_SOURCES list), so the two stay in sync.
//   2. Set `url` to that source's real listing-search page.
//   3. Write an `extract` function — it runs INSIDE the browser page via
//      page.evaluate(), so it can only use plain DOM APIs (no Node.js
//      code, no imports). Copy the Vielmon entry below as a starting
//      template; most of the Orisha/Poliris-platform sources we
//      confirmed this session (Cabinet Montoro, AFR Immobilier,
//      Patrimoine Ouest Parisien) share nearly identical HTML structure,
//      since they're built on the same agency-website platform.
//   4. Test it standalone first with test-vielmon.js-style script before
//      wiring it into the live function — a broken extractor for one
//      source should never break search results for the other sources.

const SCRAPER_CONFIG = {
  Vielmon: {
    url: 'https://www.vielmon.fr/annonces/transaction/Location.html',
    // Listing links match this pattern; selector confirmed working
    // against the live site as of this session.
    waitForSelector: 'a[href*="/fiches/"]',
    extract: () => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a[href*="/fiches/"]'));
      const seen = new Set();
      for (const link of links) {
        const href = link.href;
        if (seen.has(href)) continue;
        seen.add(href);

        let container = link.closest('div') || link.parentElement;
        for (let i = 0; i < 3 && container && container.innerText.length < 30; i++) {
          container = container.parentElement;
        }
        const text = container ? container.innerText.replace(/\s+/g, ' ').trim() : '';

        results.push({ url: href, rawText: text.slice(0, 300) });
      }
      return results;
    },
  },

  // Cabinet Montoro, AFR Immobilier, and Patrimoine Ouest Parisien were
  // all confirmed this session to run on the same Orisha/Poliris agency
  // website platform as Vielmon (same "/fiches/.../something.html" link
  // pattern, same general page structure). They are STUBBED here, not
  // yet enabled — copy the Vielmon `extract` function and swap in the
  // real URL once each one is individually tested and confirmed working,
  // the same way Vielmon was proven above. Do not assume the shared
  // platform guarantees an identical DOM — verify each one.
  //
  // 'Cabinet Montoro': {
  //   url: 'https://www.cabinet-montoro.fr/annonces/transaction/Location.html',
  //   waitForSelector: 'a[href*="/fiches/"]',
  //   extract: () => { /* same as Vielmon, verify before enabling */ },
  // },
};

module.exports = { SCRAPER_CONFIG };

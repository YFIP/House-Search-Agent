const { scrapeSources, SCRAPER_CONFIG } = require("./scrapers/scrape-runner");
const { parseListingText } = require("./scrapers/parse-listing");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const requestedSources = body.sources || [];

    // Split sources: ones with a real Catalyst scraper config get scraped
    // directly (real browser, real DOM, no AI involved). Everything else
    // still goes through Claude + web_search exactly as before. A source
    // never silently gets skipped — it always lands in exactly one of
    // these two lists.
    const scrapableSources = requestedSources.filter(name => SCRAPER_CONFIG[name]);
    const aiSearchSources = requestedSources.filter(name => !SCRAPER_CONFIG[name]);

    // Run real scraping and AI search concurrently — they're independent
    // and there's no reason to make the person wait for one before
    // starting the other.
    const [scrapeResults, aiSearchData] = await Promise.all([
      scrapableSources.length ? scrapeSources(scrapableSources) : Promise.resolve([]),
      aiSearchSources.length ? runAiSearch(body, aiSearchSources) : Promise.resolve(null),
    ]);

    // Convert scraped raw text into the same structured shape the
    // front-end already renders for AI-searched listings.
    const scrapedListings = [];
    const scrapeNotes = [];
    for (const result of scrapeResults) {
      if (result.error) {
        scrapeNotes.push(`${result.source}: ${result.error}`);
        continue;
      }
      for (const item of result.listings) {
        scrapedListings.push(parseListingText(result.source, item.url, item.rawText));
      }
      if (result.listings.length === 0) {
        scrapeNotes.push(`${result.source}: page loaded but no listings were found.`);
      }
    }

    // Merge AI-search listings (if any) with real scraped listings into
    // one combined response, in the exact shape the front-end expects:
    // { reasoning, listings }.
    const aiListings = (aiSearchData && aiSearchData.listings) || [];
    const aiReasoning = (aiSearchData && aiSearchData.reasoning) || '';
    const combinedReasoning = [
      aiReasoning,
      scrapeNotes.length ? `Scraping notes: ${scrapeNotes.join(' | ')}` : '',
    ].filter(Boolean).join(' ');

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      // NOTE: this response shape intentionally differs from the raw
      // Anthropic API passthrough this function used to return. The
      // front-end's text-block parsing (extracting JSON from Claude's
      // response) only runs when aiSearchSources is non-empty; see the
      // updated index.html parsing logic.
      body: JSON.stringify({
        prospectorResult: {
          reasoning: combinedReasoning,
          listings: [...scrapedListings, ...aiListings],
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// Runs the existing Claude + web_search path, scoped to only the sources
// that don't have a real scraper configured. Returns { reasoning, listings }
// already parsed from Claude's JSON response, or throws on failure.
async function runAiSearch(body, sourcesToSearch) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16000,
      messages: body.messages,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: body.maxSearches || 8,
        },
      ],
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || data.error);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`AI search response was cut off (too many sources for one search). Sources affected: ${sourcesToSearch.join(', ')}`);
  }

  const textBlocks = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  if (!textBlocks.trim()) {
    throw new Error('No text response received from AI search — the model may have only returned search activity.');
  }

  const cleaned = textBlocks.replace(/```json|```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('AI search response did not contain a recognizable JSON result.');
  }
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

// Converts the raw {url, rawText} pairs that scrapers extract into the
// same structured listing shape the front-end's render() function expects
// (the same shape Claude's web_search path already produces). This keeps
// scraped results and AI-searched results visually identical in the UI —
// the person using Prospector shouldn't be able to tell which path a
// given listing came from, except via genuinely real data either way.
//
// This parser is intentionally loose (regex-based) rather than strict,
// because real listing text varies in word order and punctuation between
// sources, and between individual listings on the same source. A missed
// field should leave that field blank/null, never crash the parse.

function parseListingText(sourceName, url, rawText) {
  const text = rawText || '';

  // Price: "Loyer 847 €/mois" / "Loyer 2 025 €/mois" — handles the
  // French thousands-separator space.
  const priceMatch = text.match(/(\d[\d\s]*)\s*€\s*\/\s*mois/i);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, ''), 10) : null;

  // Rooms: "1 Pièce(s)" / "3 Pièces" / "2 Pièce(S)"
  const roomsMatch = text.match(/(\d+)\s*Pi[èe]ce/i);
  const rooms = roomsMatch ? parseInt(roomsMatch[1], 10) : null;

  // Surface: "24 M²" / "60,14 M2" / "39.93 m2" — note French decimal comma
  const sqmMatch = text.match(/(\d+(?:[.,]\d+)?)\s*M[²2]/i);
  const sqm = sqmMatch ? parseFloat(sqmMatch[1].replace(',', '.')) : null;

  // Reference number: "Réf : 4201263" / "Réf: 2522"
  const refMatch = text.match(/R[ée]f\s*:?\s*(\S+)/i);
  const ref = refMatch ? refMatch[1] : null;

  // Furnished status — look for "meublé" anywhere in the text (without
  // "non meublé"/"non-meublé" immediately before it).
  const lower = text.toLowerCase();
  const meuble = lower.includes('meubl') && !lower.includes('non meubl') && !lower.includes('non-meubl');

  // Address fragment: text after the listing title, before "Loyer" —
  // best-effort, may be imprecise across different source layouts.
  const addressMatch = text.match(/,\s*([^,]+?)\s*(?:Loyer|$)/i);
  const address = addressMatch ? addressMatch[1].trim() : null;

  return {
    id: `${sourceName}-${url}`,
    source: sourceName,
    agency: sourceName, // scraped sources are the agency itself, not a network listing it
    address: address,
    url: url,
    price: price,
    pricePerSqm: (price && sqm) ? Math.round(price / sqm) : null,
    rooms: rooms,
    bedrooms: null, // not reliably present in list-view text; would need the detail page
    bathrooms: null,
    sqm: sqm,
    sqft: sqm ? Math.round(sqm * 10.764) : null,
    floor: null,
    totalFloors: null,
    meuble: meuble,
    elevator: null, // unknown from list-view text alone — left null, not false
    balcony: null,
    haussman: null,
    equippedKitchen: null,
    matchScore: 100, // scraped directly from the real source — not an AI estimate
    ref: ref,
    listedDate: null,
    isExactListing: true, // a scraped listing always points at one real property page
  };
}

module.exports = { parseListingText };

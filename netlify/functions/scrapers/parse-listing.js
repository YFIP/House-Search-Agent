
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

  // Price: real formats confirmed across sources this session:
  //   "Loyer 847 €/mois" (Vielmon/Orisha family)
  //   "1 198 € charges comprises par mois" (Perenium)
  //   "3 795 €/mois CC honoraires inclus" (Fredelion)
  //   "2659€cc" (Luxe Prestige Immo — no space before €)
  //   "7.500 € / mois (cc)" (Nicolas Devillard — period as thousands separator)
  //   "10 990€ /mois" (Quod et Associés)
  //   "31 633 £ par mois" (Breteuil Homes — lists London properties in GBP)
  // NOTE: sale prices like "302 000 €" with no /mois, /cc, or rental
  // qualifier nearby are deliberately NOT matched here — this parser is
  // for RENTAL listings, and a sale price with no rental qualifier
  // should leave price as null rather than guess wrong.
  //
  // BUG FIX (confirmed against real Cabinet Montoro listing text this
  // session): the previous pattern's leading character-class boundary
  // check ([^\d\s.]) consumed characters and fought with adjacent digit
  // groups separated only by whitespace (e.g. "Ref. : 4868 1 590
  // €/mois" failed to match "1 590" at all, because the space right
  // before "1" was preceded by "8", a digit, and the boundary check had
  // no way to "skip" that and retry from the space itself). Switched to
  // a negative lookbehind, which checks the boundary WITHOUT consuming
  // characters, fixing this. Also added an alternative for plain
  // unseparated digit runs (e.g. "2659€cc" on Luxe Prestige Immo, which
  // has no thousands separator at all) — the original pattern only
  // matched numbers built from 1-3-digit groups joined by separators
  // and silently failed on this format.
  //
  // CURRENCY FIX (confirmed against real Breteuil Homes listing text
  // this session): Breteuil lists some properties (London, etc.) in £
  // rather than €. The pattern only ever matched €, so these listings
  // silently got price: null even though a real, parseable price was
  // right there in the text. Now matches either symbol; the returned
  // price is a plain number with no currency field, which is an
  // acceptable simplification for now (Prospector is Paris-focused, and
  // mixed-currency comparison isn't meaningfully supported elsewhere in
  // the UI either) — flagging here in case currency-aware display
  // becomes worth adding later.
  const priceMatch = text.match(
    /(?<![\d.])\s*(\d{1,3}(?:[\s.]\d{3})+|\d{2,6})\s*[€£]\s*(?:\/\s*mois|\/\s*an|cc\b|charges?\s+comprises?|honoraires|par\s+mois)/i
  );
  let price = null;
  if (priceMatch) {
    // Strip thousands separators (space or period before exactly 3 digits)
    // without touching a genuine decimal point — rental prices are always
    // whole euros in these listings, so any '.' or ' ' inside the number
    // is a separator, never a decimal.
    const cleaned = priceMatch[1].replace(/[\s.]/g, '');
    const parsedPrice = parseInt(cleaned, 10);
    // Sanity bound: reject absurd values that signal a regex false-match
    // (e.g. two adjacent numbers accidentally concatenated).
    if (parsedPrice > 0 && parsedPrice < 200000) {
      price = parsedPrice;
    }
  }

  // Rooms: "1 Pièce(s)" / "3 Pièces" / "2 Pièce(S)"
  const roomsMatch = text.match(/(\d+)\s*Pi[èe]ce/i);
  const rooms = roomsMatch ? parseInt(roomsMatch[1], 10) : null;

  // Bedrooms: "3 Chambres" / "4 Chambres" — confirmed real on Breteuil
  // Homes this session, which reports bedroom count but never a total
  // "pièces" figure. Other sources (Vielmon family) mention "chambre(s)"
  // too but always alongside "pièce(s)" — capturing this here is purely
  // additive, since `rooms` above already has its own independent match.
  //
  // BUG FIX (confirmed against real Breteuil Homes text this session):
  // a trailing \b word boundary after "Chambres?" failed when the price
  // immediately follows with no separator (e.g. real text reads
  // "...3 Chambres31 633 £..." — "s" and "3" are both word characters,
  // so \b never matches between them, and the whole pattern silently
  // failed). Replaced with a lookahead for "not a word character, or
  // end of string", which correctly handles both the normal spaced
  // case (Fredelion's "3 chambre(s)") and Breteuil's glued-together case.
  const bedroomsMatch = text.match(/(\d{1,2})\s*Chambres?(?=\D|$)/i);
  const bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1], 10) : null;

  // Surface: "24 M²" / "60,14 M2" / "39.93 m2" — note French decimal comma
  // BUG FIX (confirmed against real Patrimoine Immo listing text this
  // session): the page's link title repeats a ROUNDED sqm figure twice
  // before the precise figure appears (e.g. "...11m2 GARCHES...11m2
  // GARCHES 10.5 m²..."), and a single non-global match always grabbed
  // the first, less-precise "11" instead of the real "10.5". Now finds
  // every sqm-like match in the text and prefers one with a decimal
  // point/comma (the precise figure) if any exists; otherwise falls
  // back to the LAST match, which is still better than the first for
  // this repeated-title pattern.
  const sqmMatches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*M[²2]/gi)];
  let sqm = null;
  if (sqmMatches.length) {
    const withDecimal = sqmMatches.find(m => /[.,]/.test(m[1]));
    const chosen = withDecimal || sqmMatches[sqmMatches.length - 1];
    sqm = parseFloat(chosen[1].replace(',', '.'));
  }

  // Reference number: "Réf : 4201263" / "Réf: 2522" / "Ref. : 4868"
  // BUG FIX (confirmed against real Cabinet Montoro text this session):
  // without a word boundary, this matched inside unrelated French words
  // containing "réf"/"ref" as a substring — e.g. "wc refait très
  // récemment" matched "ref" + captured "ait" as if it were a reference
  // number. \b ensures "Réf"/"Ref" must be a standalone word. Also added
  // \.? to handle "Ref." with a period (Cabinet Montoro's exact format),
  // which without this fix got captured as the reference value itself.
  const refMatch = text.match(/\bR[ée]f\b\.?\s*:?\s*(\S+)/i);
  const ref = refMatch ? refMatch[1] : null;

  // Furnished status — look for "meublé" anywhere in the text (without
  // "non meublé"/"non-meublé" immediately before it).
  const lower = text.toLowerCase();
  const meuble = lower.includes('meubl') && !lower.includes('non meubl') && !lower.includes('non-meubl');

  // Address fragment: text after the listing title, before "Loyer" —
  // works for comma-separated formats (Vielmon-family sites). For
  // sources without that comma structure (confirmed: Fredelion), fall
  // back to taking the leading text up to the first price or "pièce"
  // marker, which is consistently the title/location string across
  // every format seen this session.
  //
  // BUG FIX (confirmed against real Cabinet Montoro listing text this
  // session): the comma-pattern was unanchored and could match ANY
  // comma-to-comma fragment in a long multi-paragraph description, not
  // just the address near the title (e.g. matched "un s" — a fragment
  // from deep inside "...un séjour exposé sud-ouest, 2 chambres..." —
  // instead of finding no real address pattern and leaving it null).
  // Fixed by only searching the first ~120 characters of the text for
  // the comma-address pattern, since every confirmed real source puts
  // the address in or near the title, never buried in a long
  // description. If no match is found in that window, address stays
  // null rather than risk grabbing an unrelated sentence fragment.
  let address = null;
  const titleRegion = text.slice(0, 120);
  // BUG FIX (confirmed against real Breteuil Homes text this session):
  // the stop marker only recognized "Loyer" — Breteuil's format never
  // uses that word (it says "par mois" instead), so the non-greedy
  // match ran all the way to the end of the string and returned the
  // entire remaining text as the "address". Added m²/Chambres/par mois
  // as additional stop points, since these reliably mark where the
  // address ends across every source format confirmed so far.
  const addressMatch = titleRegion.match(/,\s*([^,]+?)\s*(?:Loyer|\d+\s*[Mm][²2]|\d+\s*Chambres?|par\s+mois|$)/i);
  if (addressMatch && addressMatch[1].trim().length >= 3) {
    address = addressMatch[1].trim();
  } else {
    const leadingMatch = titleRegion.match(/^(.*?)(?=\s+(?:Appartement|Maison|Immobilier|Loyer|\d+[\s,]*[€£]|\d+\s*pi[èe]ce))/i);
    if (leadingMatch && leadingMatch[1].trim().length >= 3) {
      address = leadingMatch[1].trim();
    }
  }

  return {
    id: `${sourceName}-${url}`,
    source: sourceName,
    agency: sourceName, // scraped sources are the agency itself, not a network listing it
    address: address,
    url: url,
    price: price,
    pricePerSqm: (price && sqm) ? Math.round(price / sqm) : null,
    rooms: rooms,
    bedrooms: bedrooms,
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

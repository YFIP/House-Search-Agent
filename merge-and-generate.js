// merge-and-generate.js
// Downloads/reads output-main.json (Barnes, Barnes-Suburbs, Junot, SeLoger
// Paris) plus every output-seloger-{slug}.json (one per suburb, each
// scraped in its own isolated GitHub Actions job), merges everything, and
// writes the final Excel file — same output shape as before, just
// assembled from multiple separate scrape runs instead of one process.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function findSeLogerSuburbFiles(dir, searchType) {
  // Specifically excludes "-arr-" files so this doesn't also match the
  // arrondissement result files below (both start with "output-seloger-").
  // searchType-aware: rent files have no suffix, sale files end in
  // "-sale.json" — both types coexist in the same artifacts folder since
  // this function runs once per searchType.
  const pattern = searchType === 'sale'
    ? /^output-seloger-(?!arr-).+-sale\.json$/
    : /^output-seloger-(?!arr-).+(?<!-sale)\.json$/;
  return fs.readdirSync(dir).filter(f => pattern.test(f));
}

function findSeLogerArrondissementFiles(dir, searchType) {
  const pattern = searchType === 'sale'
    ? /^output-seloger-arr-\d+-sale\.json$/
    : /^output-seloger-arr-\d+\.json$/;
  return fs.readdirSync(dir).filter(f => pattern.test(f));
}

function findParisRentalFiles(dir, searchType) {
  // 'sale' category file is output-parisrental-sale-1.json — distinct
  // from the rent categories (furnished/unfurnished) by name alone, no
  // extra suffix needed.
  const pattern = searchType === 'sale'
    ? /^output-parisrental-sale-.+\.json$/
    : /^output-parisrental-(furnished|unfurnished)-.+\.json$/;
  return fs.readdirSync(dir).filter(f => pattern.test(f));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function buildExcel(searchType, listings, sourceStatus, generatedAtIso) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Prospector';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Listings', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const hasDetails = listings.some(l => 'elevator' in l);

  const columns = [
    { header: 'Source', key: 'source', width: 12 },
    { header: 'Price (€)', key: 'price', width: 14 },
    { header: 'Rooms', key: 'rooms', width: 8 },
    { header: 'Bathrooms', key: 'bathrooms', width: 10 },
    { header: 'm²', key: 'sqm', width: 8 },
    { header: '€/m²', key: 'pricePerSqm', width: 12 },
    { header: 'Address', key: 'address', width: 20 },
  ];
  if (hasDetails) {
    columns.push(
      { header: 'Elevator', key: 'elevator', width: 10 },
      { header: 'Balcony', key: 'balcony', width: 10 },
      { header: 'Furnished', key: 'furnished', width: 10 }
    );
  }
  columns.push({ header: 'URL', key: 'url', width: 55 });
  sheet.columns = columns;

  const priceColIdx = columns.findIndex(c => c.key === 'price') + 1;
  const sqmColIdx = columns.findIndex(c => c.key === 'sqm') + 1;
  const pricePerSqmColIdx = columns.findIndex(c => c.key === 'pricePerSqm') + 1;
  const priceColLetter = sheet.getColumn(priceColIdx).letter;
  const sqmColLetter = sheet.getColumn(sqmColIdx).letter;

  listings.forEach(l => {
    const row = {
      source: l.source,
      price: l.priceOnRequest ? 'On request' : l.price,
      rooms: l.rooms,
      bathrooms: l.bathrooms,
      sqm: l.sqm,
      address: l.address,
      url: l.url
    };
    if (hasDetails) {
      row.elevator = l.elevator === true ? 'Yes' : l.elevator === false ? 'No' : '';
      row.balcony = l.balcony === true ? 'Yes' : l.balcony === false ? 'No' : '';
      row.furnished = l.furnished === true ? 'Yes' : l.furnished === false ? 'No' : '';
    }
    const addedRow = sheet.addRow(row);

    if (typeof l.price === 'number' && l.price > 0 && typeof l.sqm === 'number' && l.sqm > 0) {
      const r = addedRow.number;
      addedRow.getCell(pricePerSqmColIdx).value = { formula: `${priceColLetter}${r}/${sqmColLetter}${r}` };
      addedRow.getCell(pricePerSqmColIdx).numFmt = '#,##0';
    }
  });

  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  sheet.eachRow((row, i) => {
    if (i === 1) return;
    row.font = { name: 'Arial', size: 10 };
    const priceCell = row.getCell(priceColIdx);
    if (typeof priceCell.value === 'number') priceCell.numFmt = '#,##0" €"';
  });

  const info = workbook.addWorksheet('Info');
  info.getCell('A1').value = 'Prospector — Paris Listings';
  info.getCell('A1').font = { bold: true, size: 14, name: 'Arial' };
  info.getCell('A2').value = `Generated: ${new Date(generatedAtIso).toLocaleString('en-GB')}`;
  info.getCell('A2').font = { name: 'Arial' };
  sourceStatus.forEach((s, i) => {
    const cell = info.getCell(`A${3 + i}`);
    cell.value = s.error ? `${s.source}: FAILED — ${s.error}` : `${s.source}: ${s.found} listings`;
    cell.font = { name: 'Arial', color: s.error ? { argb: 'FFCC0000' } : undefined };
  });
  info.getColumn('A').width = 90;

  const filename = searchType === 'sale' ? 'listings-sale.xlsx' : 'listings.xlsx';
  await workbook.xlsx.writeFile(filename);
  return filename;
}

async function main() {
  const searchType = process.argv[2] === 'sale' ? 'sale' : 'rent';
  const artifactsDir = process.argv[3] || '.';

  console.log(`Merging main sources with individual SeLoger suburb results from: ${artifactsDir}`);

  const mainDataFilename = searchType === 'sale' ? 'output-main-sale.json' : 'output-main.json';
  const mainDataPath = path.join(artifactsDir, mainDataFilename);
  if (!fs.existsSync(mainDataPath)) {
    console.error(`Missing ${mainDataPath} — the main-sources job may not have completed or its artifact wasn't downloaded correctly.`);
    process.exit(1);
  }
  const mainData = loadJson(mainDataPath);

  const suburbFiles = findSeLogerSuburbFiles(artifactsDir, searchType);
  const arrFiles = findSeLogerArrondissementFiles(artifactsDir, searchType);
  const parisRentalFiles = findParisRentalFiles(artifactsDir, searchType);
  console.log(`Found ${suburbFiles.length} SeLoger suburb result file(s): ${suburbFiles.join(', ') || '(none)'}`);
  console.log(`Found ${arrFiles.length} SeLoger arrondissement result file(s): ${arrFiles.join(', ') || '(none)'}`);
  console.log(`Found ${parisRentalFiles.length} ParisRental category result file(s): ${parisRentalFiles.join(', ') || '(none)'}`);

  const allListings = [...mainData.listings];
  const allSourceStatus = [...mainData.sourceStatus];
  // Dedup by URL: the all-Paris search and per-arrondissement searches can
  // both surface the SAME listing — without this, that listing would be
  // double-counted in the final total.
  const seenUrls = new Set(allListings.map(l => l.url));

  for (const file of suburbFiles) {
    const result = loadJson(path.join(artifactsDir, file));
    if (result.error) {
      allSourceStatus.push({ source: `SeLoger-Suburb-${result.slug}`, found: 0, error: result.error });
    } else {
      let added = 0;
      for (const listing of result.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: `SeLoger-Suburb-${result.slug}`, found: added, error: null });
    }
  }

  for (const file of arrFiles) {
    const result = loadJson(path.join(artifactsDir, file));
    const label = `SeLoger-Paris-${result.arrondissement}e`;
    if (result.error) {
      allSourceStatus.push({ source: label, found: 0, error: result.error });
    } else {
      let added = 0;
      for (const listing of result.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: label, found: added, error: null });
    }
  }

  for (const file of parisRentalFiles) {
    const result = loadJson(path.join(artifactsDir, file));
    const label = `ParisRental-${result.category}`;
    if (result.error) {
      allSourceStatus.push({ source: label, found: 0, error: result.error });
    } else {
      let added = 0;
      for (const listing of result.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: label, found: added, error: null });
    }
  }

  const beforeRoomShareFilter = allListings.length;
  const filteredListings = allListings.filter(l => !l.isRoomShare);
  const roomShareCount = beforeRoomShareFilter - filteredListings.length;

  console.log(`\nCombined total: ${beforeRoomShareFilter} listings (${roomShareCount} room-share/colocation listings excluded, ${filteredListings.length} remaining)`);
  allSourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));

  const filename = await buildExcel(searchType, filteredListings, allSourceStatus, new Date().toISOString());
  console.log(`\n✅ Wrote ${filteredListings.length} combined listings to ${filename}`);

  // Also write listings.json for the frontend — same data, plus a
  // pre-computed normalized "area" field per listing (via
  // normalize-area.js) so the frontend doesn't need to run that logic on
  // every page load. Raw address is kept too, unmodified, for
  // transparency — the normalized area is an added filter aid, not a
  // replacement for the original text.
  const { normalizeArea } = require('./normalize-area');
  const listingsWithArea = filteredListings.map(l => ({ ...l, normalizedArea: normalizeArea(l.address) }));
  const jsonFilename = searchType === 'sale' ? 'listings-sale.json' : 'listings.json';
  fs.writeFileSync(jsonFilename, JSON.stringify({
    generatedAt: new Date().toISOString(),
    searchType,
    totalListings: listingsWithArea.length,
    sourceStatus: allSourceStatus,
    listings: listingsWithArea
  }, null, 2));
  console.log(`✅ Wrote ${listingsWithArea.length} listings to ${jsonFilename} (for the frontend)`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

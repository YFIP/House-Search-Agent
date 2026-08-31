// merge-and-generate.js
// Downloads/reads output-main.json (Barnes-Suburbs, Book-a-Flat,
// Perenium) plus the isolated Barnes/DanielFeau/Eiffel Housing/Junot
// artifacts, and every ParisRental page result — merges everything, and
// writes the final Excel file.
//
// FIX (this pass): SeLoger removed entirely — findSeLogerSuburbFiles/
// findSeLogerArrondissementFiles and the merge loops that used them are
// gone, along with the underlying scrapers and their GitHub Actions
// matrix. In their place: added handling for output-barnes.json /
// output-barnes-sale.json, mirroring the existing DanielFeau/Eiffel
// Housing/Junot blocks below, since Barnes now runs as its own isolated
// job (see scrape-single-barnes.js) instead of inside output-main.json.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function findParisRentalFiles(dir, searchType) {
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
      row.elevator = l.elevator === true ? 'Yes' : l.elevator === false ? 'No' : 'Not mentioned';
      row.balcony = l.balcony === true ? 'Yes' : l.balcony === false ? 'No' : 'Not mentioned';
      row.furnished = l.furnished === true ? 'Yes' : l.furnished === false ? 'No' : 'Not mentioned';
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

  console.log(`Merging main sources with isolated-job results from: ${artifactsDir}`);

  const mainDataFilename = searchType === 'sale' ? 'output-main-sale.json' : 'output-main.json';
  const mainDataPath = path.join(artifactsDir, mainDataFilename);
  if (!fs.existsSync(mainDataPath)) {
    console.error(`Missing ${mainDataPath} — the main-sources job may not have completed or its artifact wasn't downloaded correctly.`);
    process.exit(1);
  }
  const mainData = loadJson(mainDataPath);

  const parisRentalFiles = findParisRentalFiles(artifactsDir, searchType);
  console.log(`Found ${parisRentalFiles.length} ParisRental category result file(s): ${parisRentalFiles.join(', ') || '(none)'}`);

  const barnesFilename = searchType === 'sale' ? 'output-barnes-sale.json' : 'output-barnes.json';
  const barnesPath = path.join(artifactsDir, barnesFilename);
  const barnesResult = fs.existsSync(barnesPath) ? loadJson(barnesPath) : null;
  console.log(`Barnes result file: ${fs.existsSync(barnesPath) ? barnesFilename : '(not found)'}`);

  const danielFeauFilename = searchType === 'sale' ? 'output-danielfeau-sale.json' : 'output-danielfeau.json';
  const danielFeauPath = path.join(artifactsDir, danielFeauFilename);
  const danielFeauResult = fs.existsSync(danielFeauPath) ? loadJson(danielFeauPath) : null;
  console.log(`DanielFeau result file: ${fs.existsSync(danielFeauPath) ? danielFeauFilename : '(not found)'}`);

  const eiffelHousingFilename = searchType === 'sale' ? 'output-eiffel-housing-sale.json' : 'output-eiffel-housing.json';
  const eiffelHousingPath = path.join(artifactsDir, eiffelHousingFilename);
  const eiffelHousingResult = fs.existsSync(eiffelHousingPath) ? loadJson(eiffelHousingPath) : null;
  console.log(`Eiffel Housing result file: ${fs.existsSync(eiffelHousingPath) ? eiffelHousingFilename : '(not found)'}`);

  // NEW — Junot moved to its own isolated job (see scrape-single-junot.js)
  // after adding real detail-page enrichment for furnished status.
  // Optional here (like DanielFeau/Eiffel Housing above) since that job
  // could theoretically fail without blocking the rest of the merge.
  const junotFilename = searchType === 'sale' ? 'output-junot-sale.json' : 'output-junot.json';
  const junotPath = path.join(artifactsDir, junotFilename);
  const junotResult = fs.existsSync(junotPath) ? loadJson(junotPath) : null;
  console.log(`Junot result file: ${fs.existsSync(junotPath) ? junotFilename : '(not found)'}`);

  const allListings = [...mainData.listings];
  const allSourceStatus = [...mainData.sourceStatus];
  const seenUrls = new Set(allListings.map(l => l.url));

  // NEW — Barnes moved to its own isolated job (see scrape-single-barnes.js).
  // Same pattern as DanielFeau/Eiffel Housing/Junot below.
  if (barnesResult) {
    if (barnesResult.error) {
      allSourceStatus.push({ source: 'Barnes', found: 0, error: barnesResult.error });
    } else {
      let added = 0;
      for (const listing of barnesResult.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: 'Barnes', found: added, error: null });
    }
  } else {
    allSourceStatus.push({ source: 'Barnes', found: 0, error: 'Isolated job artifact not found' });
  }

  // NEW — Orpi moved to its own isolated job (see scrape-single-orpi.js).
  // Same pattern as Barnes/DanielFeau/Eiffel Housing/Junot above.
  const orpiFilename = searchType === 'sale' ? 'output-orpi-sale.json' : 'output-orpi.json';
  const orpiPath = path.join(artifactsDir, orpiFilename);
  const orpiResult = fs.existsSync(orpiPath) ? loadJson(orpiPath) : null;
  console.log(`Orpi result file: ${fs.existsSync(orpiPath) ? orpiFilename : '(not found)'}`);
  if (orpiResult) {
    if (orpiResult.error) {
      allSourceStatus.push({ source: 'Orpi', found: 0, error: orpiResult.error });
    } else {
      let added = 0;
      for (const listing of orpiResult.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: 'Orpi', found: added, error: null });
    }
  } else {
    allSourceStatus.push({ source: 'Orpi', found: 0, error: 'Isolated job artifact not found' });
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

  if (danielFeauResult) {
    if (danielFeauResult.error) {
      allSourceStatus.push({ source: 'DanielFeau', found: 0, error: danielFeauResult.error });
    } else {
      let added = 0;
      for (const listing of danielFeauResult.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: 'DanielFeau', found: added, error: null });
    }
  } else {
    allSourceStatus.push({ source: 'DanielFeau', found: 0, error: 'Isolated job artifact not found' });
  }

  if (eiffelHousingResult) {
    if (eiffelHousingResult.error) {
      allSourceStatus.push({ source: 'Eiffel Housing', found: 0, error: eiffelHousingResult.error });
    } else {
      let added = 0;
      for (const listing of eiffelHousingResult.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: 'Eiffel Housing', found: added, error: null });
    }
  } else {
    allSourceStatus.push({ source: 'Eiffel Housing', found: 0, error: 'Isolated job artifact not found' });
  }

  // NEW — same pattern as DanielFeau/Eiffel Housing above.
  if (junotResult) {
    if (junotResult.error) {
      allSourceStatus.push({ source: 'Junot', found: 0, error: junotResult.error });
    } else {
      let added = 0;
      for (const listing of junotResult.listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        allListings.push(listing);
        added++;
      }
      allSourceStatus.push({ source: 'Junot', found: added, error: null });
    }
  } else {
    allSourceStatus.push({ source: 'Junot', found: 0, error: 'Isolated job artifact not found' });
  }

  const beforeRoomShareFilter = allListings.length;
  const filteredListings = allListings.filter(l => !l.isRoomShare);
  const roomShareCount = beforeRoomShareFilter - filteredListings.length;

  console.log(`\nCombined total: ${beforeRoomShareFilter} listings (${roomShareCount} room-share/colocation listings excluded, ${filteredListings.length} remaining)`);
  allSourceStatus.forEach(s => console.log(`  ${s.source}: ${s.error ? 'FAILED - ' + s.error : s.found + ' listings'}`));

  const filename = await buildExcel(searchType, filteredListings, allSourceStatus, new Date().toISOString());
  console.log(`\n✅ Wrote ${filteredListings.length} combined listings to ${filename}`);

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

const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrapeBarnes() {
  let browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.barnes-international.com/fr/location.html', { waitUntil: 'networkidle0', timeout: 30000 });
  
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).forEach(btn => {
      if (btn.innerText.toLowerCase().includes('autoriser')) btn.click();
    });
  });
  
  await new Promise(r => setTimeout(r, 3000));
  
  const listings = await page.evaluate(() => {
    const text = document.body.innerText;
    const results = [];
    const matches = text.matchAll(/(\d+[\s\.]*\d*)\s*€\s*\/\s*mois/g);
    for (const match of matches) {
      const price = parseInt(match[1].replace(/[\s\.]/g, ''));
      if (price > 500 && price < 50000) {
        results.push({ source: 'barnes-international', type: 'rental', price, address: 'Paris' });
      }
    }
    return results;
  });
  
  await browser.close();
  return listings;
}

(async () => {
  const listings = await scrapeBarnes();
  if (!fs.existsSync('data')) fs.mkdirSync('data');
  fs.writeFileSync('data/listings.json', JSON.stringify({ timestamp: new Date().toISOString(), sources: { 'barnes-international': listings } }, null, 2));
  console.log('Scraped', listings.length, 'listings');
})();

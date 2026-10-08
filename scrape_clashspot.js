const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE_URL = 'https://clashspot.net/en/rankings/players/legend';
const START_PAGE = Number(process.env.START_PAGE || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 200);
const DELAY_MS = Number(process.env.DELAY_MS || 2000); // Increased default to avoid CAPTCHAs
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'output/clashspot-legend-tags.json';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractTagsFromHtml(html) {
  const tagSet = new Set();
  // More flexible regex to handle various URL endings
  const regex = /\/en\/player\/([A-Z0-9]+)(?:\/|["'?#\s])/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    tagSet.add('#' + match[1]);
  }

  return Array.from(tagSet);
}

function extractTotalPagesFromHtml(html) {
  const match = html.match(/Page\s+\d+\s+of\s+([\d,]+)/i);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ''), 10);
}

async function detectCaptcha(page) {
  const captchaIndicators = await page.evaluate(() => {
    const indicators = [];
    
    // Check for common CAPTCHA/bot-check elements
    if (document.querySelector('[class*="captcha"]')) indicators.push('captcha_class');
    if (document.querySelector('[id*="captcha"]')) indicators.push('captcha_id');
    if (document.body.innerText.includes('Are you a robot')) indicators.push('robot_check_text');
    if (document.body.innerText.includes('hCaptcha')) indicators.push('hcaptcha_text');
    if (document.body.innerText.includes('Cloudflare')) indicators.push('cloudflare_text');
    if (document.querySelector('iframe[src*="captcha"]')) indicators.push('captcha_iframe');
    if (document.querySelector('iframe[src*="challenges"]')) indicators.push('challenge_iframe');
    
    return indicators;
  });

  return captchaIndicators;
}

async function fetchPage(browser, pageNum) {
  const page = await browser.newPage();

  try {
    // Set headers to appear as a real browser
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://clashspot.net/'
    });

    // Hide webdriver property
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });
    });

    const url = `${BASE_URL}?p=${pageNum}`;
    console.log(`Loading ${url}...`);

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for player links to appear
    try {
      await page.waitForSelector('a[href*="/en/player/"]', { timeout: 10000 });
    } catch (err) {
      console.warn('Player links selector not found; continuing with current DOM.');
    }

    // Extra delay to allow dynamic content to fully load
    await sleep(3000);

    // Check for CAPTCHA indicators
    const captchaDetected = await detectCaptcha(page);
    if (captchaDetected.length > 0) {
      console.error(`⚠️  CAPTCHA DETECTED: ${captchaDetected.join(', ')}`);
      console.error('The site is blocking automated access. You may need to:');
      console.error('  1. Use a proxy service');
      console.error('  2. Increase DELAY_MS to slow down requests');
      console.error('  3. Add manual verification or use a CAPTCHA solving service');
    }

    const html = await page.content();

    // Log first portion of HTML for debugging
    if (DEBUG_MODE) {
      const htmlPreview = html.slice(0, 5000);
      const debugFile = `debug-page-${pageNum}.html`;
      fs.writeFileSync(debugFile, html);
      console.log(`Debug: Full HTML saved to ${debugFile}`);
      console.log(`Debug: HTML preview (first 5000 chars):\n${htmlPreview}\n`);
    }

    // Check page content for indicators
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    console.log(`Page text preview: ${pageText.substring(0, 200)}...`);

    return html;
  } finally {
    await page.close();
  }
}

async function main() {
  const outputDir = path.dirname(OUTPUT_PATH);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Starting scraper with settings:`);
  console.log(`  START_PAGE: ${START_PAGE}`);
  console.log(`  MAX_PAGES: ${MAX_PAGES}`);
  console.log(`  DELAY_MS: ${DELAY_MS}`);
  console.log(`  DEBUG_MODE: ${DEBUG_MODE}`);
  console.log(`  OUTPUT_PATH: ${OUTPUT_PATH}`);
  console.log('');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  try {
    const allTags = new Set();
    let page = START_PAGE;
    let totalPages = null;
    let consecutiveEmptyPages = 0;

    while (page <= MAX_PAGES) {
      console.log(`\nFetching page ${page}${totalPages ? ' / ' + totalPages : ''}...`);

      try {
        const html = await fetchPage(browser, page);
        const tags = extractTagsFromHtml(html);

        if (!tags.length) {
          consecutiveEmptyPages++;
          console.log(`No tags found on page ${page}. (consecutive empty pages: ${consecutiveEmptyPages})`);
          
          // Stop after 3 consecutive empty pages (likely hit CAPTCHA or end of results)
          if (consecutiveEmptyPages >= 3) {
            console.log('Stopping: 3 consecutive empty pages detected.');
            break;
          }
        } else {
          consecutiveEmptyPages = 0; // Reset counter on successful extraction
          tags.forEach(tag => allTags.add(tag));
          console.log(`✓ Found ${tags.length} tags on page ${page}.`);

          const parsedTotalPages = extractTotalPagesFromHtml(html);
          if (parsedTotalPages) {
            totalPages = parsedTotalPages;
            console.log(`  Detected total pages: ${totalPages}`);
          }

          if (totalPages && page >= totalPages) {
            console.log(`✓ Reached last page (${totalPages}).`);
            break;
          }
        }

        page += 1;

        if (DELAY_MS > 0) {
          console.log(`  Waiting ${DELAY_MS}ms before next request...`);
          await sleep(DELAY_MS);
        }
      } catch (err) {
        console.error(`✗ Error at page ${page}: ${err.message}`);
        console.error('  Stopping scraper.');
        break;
      }
    }

    const finalTags = Array.from(allTags).sort();
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalTags, null, 2));
    console.log(`\n✓ Saved ${finalTags.length} unique tags to ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://clashspot.net/en/rankings/players/legend';
const START_PAGE = Number(process.env.START_PAGE || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 200);
const DELAY_MS = Number(process.env.DELAY_MS || 3000);
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'output/clashspot-legend-tags.json';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractTagsFromHtml(html) {
  const tagSet = new Set();
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
    
    if (document.querySelector('[class*="captcha"]')) indicators.push('captcha_class');
    if (document.querySelector('[id*="captcha"]')) indicators.push('captcha_id');
    if (document.body.innerText.includes('Are you a robot')) indicators.push('robot_check_text');
    if (document.body.innerText.includes('hCaptcha')) indicators.push('hcaptcha_text');
    if (document.body.innerText.includes('Cloudflare')) indicators.push('cloudflare_text');
    if (document.body.innerText.includes('security verification')) indicators.push('cloudflare_verification');
    if (document.querySelector('iframe[src*="captcha"]')) indicators.push('captcha_iframe');
    if (document.querySelector('iframe[src*="challenges"]')) indicators.push('challenge_iframe');
    
    return indicators;
  });

  return captchaIndicators;
}

async function waitForCloudflareChallenge(page) {
  // Wait for Cloudflare challenge to complete (up to 30 seconds)
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    console.log('  Cloudflare challenge completed.');
    return true;
  } catch (err) {
    console.warn('  Cloudflare challenge did not complete in time.');
    return false;
  }
}

async function fetchPage(browser, pageNum) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://clashspot.net/'
    });

    const url = `${BASE_URL}?p=${pageNum}`;
    console.log(`Loading ${url}...`);

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Check for Cloudflare challenge and wait for it to complete
    await sleep(2000);
    let captchaDetected = await detectCaptcha(page);
    
    if (captchaDetected.some(ind => ind.includes('cloudflare'))) {
      console.log('  Cloudflare challenge detected, waiting for completion...');
      await waitForCloudflareChallenge(page);
      await sleep(3000);
      captchaDetected = await detectCaptcha(page);
    }

    // Wait for player links
    try {
      await page.waitForSelector('a[href*="/en/player/"]', { timeout: 10000 });
      console.log('  Player links loaded.');
    } catch (err) {
      console.warn('  Player links selector not found; continuing with current DOM.');
    }

    await sleep(2000);

    // Final CAPTCHA check
    captchaDetected = await detectCaptcha(page);
    if (captchaDetected.length > 0) {
      console.error(`⚠️  CAPTCHA STILL PRESENT: ${captchaDetected.join(', ')}`);
      console.error('  The site is still blocking access. Consider:');
      console.error('    - Increasing DELAY_MS further');
      console.error('    - Using a proxy service');
      console.error('    - Manual verification');
    }

    const html = await page.content();

    if (DEBUG_MODE) {
      const debugFile = `debug-page-${pageNum}.html`;
      fs.writeFileSync(debugFile, html);
      console.log(`  Debug: HTML saved to ${debugFile}`);
    }

    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    if (DEBUG_MODE) {
      console.log(`  Page text preview: ${pageText.substring(0, 150)}...`);
    }

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
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-web-resources'
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
          
          if (consecutiveEmptyPages >= 2) {
            console.log('Stopping: Multiple empty pages detected (likely CAPTCHA block).');
            break;
          }
        } else {
          consecutiveEmptyPages = 0;
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

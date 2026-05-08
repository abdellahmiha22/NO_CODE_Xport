const { chromium } = require('playwright');
const cheerio = require('cheerio');

let browserInstance = null;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await chromium.launch({ headless: true });
    }
    return browserInstance;
}

async function captureSnapshot(url) {
    let context = null;
    let page = null;
    try {
        console.log(`[Snapshot] Using browser for ${url}...`);
        const browser = await getBrowser();
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        page = await context.newPage();

        // Navigate and wait for network to be mostly idle
        console.log(`[Snapshot] Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

        // Scroll to the bottom to trigger lazy loading images
        console.log(`[Snapshot] Scrolling to trigger lazy loaded assets...`);
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 200;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight || totalHeight > 20000) {
                        clearInterval(timer);
                        window.scrollTo(0, 0);
                        resolve();
                    }
                }, 100);
            });
        });

        // Wait a bit more for images to load
        await page.waitForTimeout(2000);

        // Extract the fully rendered HTML
        console.log(`[Snapshot] Extracting HTML...`);
        let html = await page.content();

        // Process HTML to remove problematic JS that causes hydration crashes offline
        const $ = cheerio.load(html);

        // Remove scripts that cause "white screen" hydration crashes (like Squarespace/React rehydration)
        // We keep JSON-LD for SEO data, but remove execution scripts
        $('script:not([type="application/ld+json"])').remove();
        
        // Convert any data-src to src so images load without JS
        $('img[data-src]').each((i, el) => {
            const dataSrc = $(el).attr('data-src');
            if (dataSrc) {
                $(el).attr('src', dataSrc);
            }
        });
        
        $('img[data-image]').each((i, el) => {
            const dataImg = $(el).attr('data-image');
            if (dataImg && !$(el).attr('src')) {
                $(el).attr('src', dataImg);
            }
        });

        // Return the cleaned, fully rendered HTML
        html = $.html();
        return html;

    } catch (err) {
        console.error(`[Snapshot] Error capturing ${url}:`, err);
        throw err;
    } finally {
        if (page) await page.close();
        if (context) await context.close();
    }
}

async function closeBrowser() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
    }
}

module.exports = { captureSnapshot, closeBrowser };

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const archiver = require('archiver');
const { URL } = require('url');

const app = express();
app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.json());

// Serve the frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to remove watermarks cleanly
function removeWatermarks($) {
    // Webflow badges (static DOM elements if any)
    $('.w-webflow-badge').remove();
    // Framer badges (static DOM elements if any)
    $('#__framer-badge-container').remove();
    $('a[href*="framer.com/showcase"]').remove();
    $('div:has(> a[href*="framer.com/showcase"])').remove();
    // Wix badges (static DOM elements if any)
    $('#WIX_ADS').remove();
    
    // Wix comment nodes removal
    $('*').contents().filter(function() {
        return this.nodeType === 8 && this.data && this.data.includes('Wix');
    }).remove();
    
    // Some general watermarks
    $('[id*="watermark"]').remove();
    $('[class*="watermark"]').remove();

    // DYNAMIC REMOVAL: Inject CSS to hide watermarks that are inserted by builder's JS on load
    const styleText = `
    /* Webflow Watermark Removal */
    .w-webflow-badge, a.w-webflow-badge, a[href*="webflow.com?utm_campaign=brandjs"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    /* Framer Watermark Removal */
    #__framer-badge-container, a[href*="framer.com/showcase"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    /* Wix Watermark Removal */
    #WIX_ADS, div[data-testid="wix-ads"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    `;
    $('head').append(`<style id="nocodexport-watermark-remover">${styleText}</style>`);
    
    return $.html();
}

// Convert links, scripts, and media to absolute URLs
function makeUrlsAbsolute($, baseUrl) {
    const resolveUrl = (currentUrl) => {
        if (!currentUrl || currentUrl.startsWith('http') || currentUrl.startsWith('data:') || currentUrl.startsWith('blob:')) {
            return currentUrl;
        }
        try {
            return new URL(currentUrl, baseUrl).href;
        } catch (e) {
            return currentUrl;
        }
    };

    $('link[href]').each((i, el) => {
        $(el).attr('href', resolveUrl($(el).attr('href')));
    });

    $('script[src]').each((i, el) => {
        $(el).attr('src', resolveUrl($(el).attr('src')));
    });

    $('img[src], source[src]').each((i, el) => {
        $(el).attr('src', resolveUrl($(el).attr('src')));
    });

    $('img[srcset], source[srcset]').each((i, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
            const newSrcset = srcset.split(',').map(s => {
                const parts = s.trim().split(' ');
                if (parts[0]) {
                    parts[0] = resolveUrl(parts[0]);
                }
                return parts.join(' ');
            }).join(', ');
            $(el).attr('srcset', newSrcset);
        }
    });

    $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.startsWith('/')) {
            $(el).attr('href', resolveUrl(href));
        }
    });
}

// Fetch helper with fake user-agent to bypass some blocks
async function fetchPage(targetUrl) {
    const response = await axios.get(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 15000,
        responseType: 'text'
    });
    return response.data;
}

// Single Page Export ENDPOINT
app.post('/api/export/single', async (req, res) => {
    try {
        let { targetUrl } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

        if (!targetUrl.startsWith('http')) {
            targetUrl = 'https://' + targetUrl;
        }
        
        const parsedUrl = new URL(targetUrl);
        const finalUrl = parsedUrl.href;

        const html = await fetchPage(finalUrl);
        const $ = cheerio.load(html);

        makeUrlsAbsolute($, finalUrl);
        const cleanHtml = removeWatermarks($);
        const hostname = parsedUrl.hostname.replace('www.', '');

        res.setHeader('Content-Type', 'text/html');
        // Setting content disposition correctly so filename is downloaded correctly
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-export.html"`);
        return res.send(cleanHtml);

    } catch (err) {
        console.error("Single Export Error:", err.message);
        const errorMsg = err.response ? `HTTP ${err.response.status}` : err.message;
        return res.status(500).json({ error: `Failed to fetch website: ${errorMsg}` });
    }
});


// Full Site ZIP Export ENDPOINT
app.post('/api/export/zip', async (req, res) => {
    try {
        let { targetUrl } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

        if (!targetUrl.startsWith('http')) {
            targetUrl = 'https://' + targetUrl;
        }
        
        const parsedUrl = new URL(targetUrl);
        const baseUrl = parsedUrl.origin;
        const hostname = parsedUrl.hostname.replace('www.', '');
        
        // Let's set up the archiver response
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-full-export.zip"`);

        const archive = archiver('zip', {
            zlib: { level: 9 } // Sets the compression level.
        });

        // Listen for all archive warnings/errors
        archive.on('warning', function(err) {
            if (err.code === 'ENOENT') {
                console.warn(err);
            } else {
                throw err;
            }
        });

        archive.on('error', function(err) {
            throw err;
        });

        // Pipe archive data to the response
        archive.pipe(res);

        // Fetch Homepage
        const visited = new Set();
        const queue = [finalUrl = parsedUrl.href];

        // A simple BFS crawler
        let pagesCount = 0;
        const MAX_PAGES = 15; // Limit crawl to avoid timeouts and infinite loops
        
        while(queue.length > 0 && pagesCount < MAX_PAGES) {
            const currentUrl = queue.shift();
            
            // Normalize currentUrl for checking visits
            let checkUrl = currentUrl.split('#')[0]; // Ignore fragments
            if (checkUrl.endsWith('/')) checkUrl = checkUrl.slice(0, -1);
            
            if (visited.has(checkUrl)) continue;
            visited.add(checkUrl);
            
            try {
                const html = await fetchPage(currentUrl);
                pagesCount++;
                
                const $ = cheerio.load(html);
                
                // Find all local links to add to Queue
                $('a[href]').each((i, el) => {
                    let href = $(el).attr('href');
                    if(href) {
                        try {
                            const linkUrl = new URL(href, baseUrl);
                            // If it belongs to same domain, and not an asset file (naive check)
                            if (linkUrl.origin === baseUrl && !href.match(/\.(png|jpg|jpeg|gif|css|js|pdf|zip)$/i)) {
                                queue.push(linkUrl.href);
                            }
                        } catch(e) {}
                    }
                });

                // Clean the page HTML 
                makeUrlsAbsolute($, baseUrl);
                const cleanHtml = removeWatermarks($);
                
                // Determine file path in ZIP
                let pathName = new URL(checkUrl).pathname;
                if (pathName === '' || pathName === '/') {
                    pathName = 'index.html';
                } else {
                    if(!pathName.endsWith('.html')) {
                        // Create a clean path e.g. /about => about.html, /about/ => about/index.html
                        if(pathName.endsWith('/')) {
                            pathName = pathName + 'index.html';
                        } else {
                            pathName = pathName + '.html';
                        }
                    }
                    if(pathName.startsWith('/')) {
                        pathName = pathName.slice(1);
                    }
                }
                
                // Add the cleaned HTML file to the zip archive
                archive.append(cleanHtml, { name: pathName });

            } catch (pageErr) {
                console.error(`Failed to crawl ${currentUrl}:`, pageErr.message);
                // We just skip it and continue
            }
        }

        // Finalize the archive, telling it we are done appending
        await archive.finalize();

    } catch (err) {
        console.error("ZIP Export Error:", err.message);
        if (!res.headersSent) {
            return res.status(500).json({ error: `ZIP Export Failed: ${err.message}` });
        }
        // If headers are sent (i.e. archiver already started piping), we can't send JSON anymore.
    }
});

const puppeteer = require('puppeteer');

// Figma / PDF Export ENDPOINT
app.post('/api/export/figma', async (req, res) => {
    try {
        let { targetUrl } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

        if (!targetUrl.startsWith('http')) {
            targetUrl = 'https://' + targetUrl;
        }
        
        const parsedUrl = new URL(targetUrl);
        const hostname = parsedUrl.hostname.replace('www.', '');

        const browser = await puppeteer.launch({ 
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const page = await browser.newPage();
        
        // Emulate desktop
        await page.setViewport({ width: 1440, height: 900 });
        
        // Wait until there are no more than 2 network connections for at least 500 ms
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Hide watermarks before generating the layout
        await page.evaluate(() => {
            const style = document.createElement('style');
            style.innerHTML = `
                .w-webflow-badge, a.w-webflow-badge, a[href*="webflow.com?utm_campaign=brandjs"],
                #__framer-badge-container, a[href*="framer.com/showcase"],
                #WIX_ADS, div[data-testid="wix-ads"] { 
                    display: none !important; 
                    opacity: 0 !important; 
                    visibility: hidden !important; 
                }
            `;
            document.head.appendChild(style);
        });

        // Get total page height
        const height = await page.evaluate(() => document.documentElement.scrollHeight);

        // Generate PDF
        // Note: page.pdf generates a PDF which is easily imported into Figma keeping vectors/fonts nicely formatted
        const pdfBuffer = await page.pdf({
            printBackground: true,
            width: '1440px',
            height: height + 'px',
            pageRanges: '1'
        });

        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-design.pdf"`);
        return res.send(pdfBuffer);

    } catch (err) {
        console.error("Figma Export Error:", err.message);
        return res.status(500).json({ error: `Figma Export Failed: ${err.message}` });
    }
});

const port = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
    const server = app.listen(port, () => {
        console.log(`Export Server running on http://localhost:${port}`);
    }).on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use.`);
            process.exit(1);
        }
    });
}

module.exports = app;

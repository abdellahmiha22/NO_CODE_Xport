const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const archiver = require('archiver');
const { URL } = require('url');
const { convertToNextJS } = require('./nextjs-converter');
const { detectPlatform } = require('./platform-detector');
const { convertFramerToNextJS } = require('./framer-converter');
const { convertForms } = require('./form-converter');
const { extractTokens, buildTailwindConfig } = require('./token-extractor');
const { captureSnapshot, closeBrowser } = require('./snapshot');

const app = express();
app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.json());

// Serve the frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
//  ASSET COLLECTOR — Deduplicates & organizes discovered assets
// ═══════════════════════════════════════════════════════════════
class AssetCollector {
    constructor() {
        // Map of absoluteURL → { localPath, type, downloaded, buffer }
        this.assets = new Map();
        this.counters = { css: 0, js: 0, images: 0, fonts: 0, media: 0 };
    }

    /**
     * Register an asset URL. Returns the local path assigned.
     * If already registered, returns the existing local path (dedup).
     */
    add(absoluteUrl, type) {
        if (!absoluteUrl || absoluteUrl.startsWith('data:') || absoluteUrl.startsWith('blob:') || absoluteUrl.startsWith('javascript:')) {
            return null;
        }

        // Normalize URL (strip fragment, trailing whitespace)
        let cleanUrl;
        try {
            const u = new URL(absoluteUrl);
            u.hash = '';
            cleanUrl = u.href;
        } catch (e) {
            return null;
        }

        if (this.assets.has(cleanUrl)) {
            return this.assets.get(cleanUrl).localPath;
        }

        // Determine folder & filename
        const folder = this._folderForType(type);
        let filename = this._extractFilename(cleanUrl, type);

        // Ensure unique filename
        const existingNames = new Set(
            [...this.assets.values()].map(a => a.localPath)
        );
        let finalPath = `${folder}/${filename}`;
        let counter = 1;
        while (existingNames.has(finalPath)) {
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            finalPath = `${folder}/${base}-${counter}${ext}`;
            counter++;
        }

        this.assets.set(cleanUrl, {
            localPath: finalPath,
            type,
            downloaded: false,
            buffer: null,
        });

        this.counters[type] = (this.counters[type] || 0) + 1;
        return finalPath;
    }

    getLocalPath(absoluteUrl) {
        if (!absoluteUrl) return null;
        try {
            const u = new URL(absoluteUrl);
            u.hash = '';
            const entry = this.assets.get(u.href);
            return entry ? entry.localPath : null;
        } catch {
            return null;
        }
    }

    getAllByType(type) {
        return [...this.assets.entries()]
            .filter(([, v]) => v.type === type)
            .map(([url, v]) => ({ url, ...v }));
    }

    getAll() {
        return [...this.assets.entries()].map(([url, v]) => ({ url, ...v }));
    }

    setBuffer(absoluteUrl, buffer) {
        try {
            const u = new URL(absoluteUrl);
            u.hash = '';
            const entry = this.assets.get(u.href);
            if (entry) {
                entry.buffer = buffer;
                entry.downloaded = true;
            }
        } catch {}
    }

    _folderForType(type) {
        const map = {
            css: 'css',
            js: 'js',
            images: 'images',
            fonts: 'fonts',
            media: 'media',
        };
        return map[type] || 'assets';
    }

    _extractFilename(urlStr, type) {
        try {
            const u = new URL(urlStr);
            let pathname = u.pathname;

            // Get the last path segment
            let filename = path.basename(pathname);

            // Remove query params from filename
            filename = filename.split('?')[0];

            // If no extension or empty, assign one
            if (!filename || filename === '/' || !path.extname(filename)) {
                const ext = this._defaultExtForType(type);
                const index = this.counters[type] || 0;
                filename = `${type}-${index}${ext}`;
            }

            // Clean problematic characters
            filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

            // Truncate very long filenames
            if (filename.length > 100) {
                const ext = path.extname(filename);
                filename = filename.substring(0, 90) + ext;
            }

            return filename;
        } catch {
            return `${type}-${Date.now()}${this._defaultExtForType(type)}`;
        }
    }

    _defaultExtForType(type) {
        const map = {
            css: '.css',
            js: '.js',
            images: '.png',
            fonts: '.woff2',
            media: '.mp4',
        };
        return map[type] || '.bin';
    }
}

// ═══════════════════════════════════════════════════════════════
//  WATERMARK REMOVAL
// ═══════════════════════════════════════════════════════════════
function removeWatermarks($) {
    // Webflow badges
    $('.w-webflow-badge').remove();
    // Webflow template promotional widgets (pentaclay / "Buy For $79")
    $('.template-buttons-wrapper').remove();
    $('.template-promotional-button-wrap').remove();
    $('.grab-now-button').remove();
    $('a[href*="webflow.com/templates"]').closest('div').remove();
    $('a[href*="pentaclay.com"]').closest('div').remove();
    // Framer badges
    $('#__framer-badge-container').remove();
    $('a[href*="framer.com/showcase"]').remove();
    $('div:has(> a[href*="framer.com/showcase"])').remove();
    // Wix badges
    $('#WIX_ADS').remove();

    // Wix comment nodes
    $('*').contents().filter(function () {
        return this.nodeType === 8 && this.data && this.data.includes('Wix');
    }).remove();

    // Generic watermarks
    $('[id*="watermark"]').remove();
    $('[class*="watermark"]').remove();

    // Inject CSS to hide dynamically-added watermarks (defense-in-depth)
    const styleText = `
    /* Webflow Watermark Removal */
    .w-webflow-badge, a.w-webflow-badge, a[href*="webflow.com?utm_campaign=brandjs"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    /* Webflow Template Promotional Widget */
    .template-buttons-wrapper, .template-promotional-button-wrap, .grab-now-button, a[href*="webflow.com/templates"], a[href*="pentaclay.com"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    /* Framer Watermark Removal */
    #__framer-badge-container, a[href*="framer.com/showcase"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    /* Wix Watermark Removal */
    #WIX_ADS, div[data-testid="wix-ads"] { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -9999 !important; }
    `;
    $('head').append(`<style id="nocodexport-watermark-remover">${styleText}</style>`);
}

// ═══════════════════════════════════════════════════════════════
//  URL RESOLUTION HELPERS
// ═══════════════════════════════════════════════════════════════
function resolveUrl(currentUrl, baseUrl) {
    if (!currentUrl || currentUrl.startsWith('data:') || currentUrl.startsWith('blob:') || currentUrl.startsWith('javascript:') || currentUrl.startsWith('#')) {
        return null;
    }
    try {
        return new URL(currentUrl, baseUrl).href;
    } catch {
        return null;
    }
}

function classifyAssetByUrl(url) {
    if (!url) return null;
    const lower = url.toLowerCase();
    const pathname = (() => { try { return new URL(lower).pathname; } catch { return lower; } })();

    if (/\.(css)(\?|$)/i.test(pathname)) return 'css';
    if (/\.(js|mjs)(\?|$)/i.test(pathname)) return 'js';
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(pathname)) return 'fonts';
    if (/\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?)(\?|$)/i.test(pathname)) return 'images';
    if (/\.(mp4|webm|ogg|avi|mov|mp3|wav|flac|aac)(\?|$)/i.test(pathname)) return 'media';
    return null;
}

function classifyByContentType(contentType) {
    if (!contentType) return null;
    const ct = contentType.toLowerCase();
    if (ct.includes('css')) return 'css';
    if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
    if (ct.includes('font') || ct.includes('woff') || ct.includes('ttf') || ct.includes('otf')) return 'fonts';
    if (ct.includes('image') || ct.includes('svg')) return 'images';
    if (ct.includes('video') || ct.includes('audio')) return 'media';
    return null;
}

// ═══════════════════════════════════════════════════════════════
//  EXTRACT ASSETS FROM HTML
// ═══════════════════════════════════════════════════════════════
function extractAssetsFromHTML($, baseUrl, collector) {
    // --- CSS Stylesheets ---
    $('link[rel="stylesheet"][href], link[type="text/css"][href]').each((i, el) => {
        const href = resolveUrl($(el).attr('href'), baseUrl);
        if (href) collector.add(href, 'css');
    });

    // --- Preloaded stylesheets ---
    $('link[rel="preload"][as="style"][href]').each((i, el) => {
        const href = resolveUrl($(el).attr('href'), baseUrl);
        if (href) collector.add(href, 'css');
    });

    // --- JavaScript ---
    $('script[src]').each((i, el) => {
        const src = resolveUrl($(el).attr('src'), baseUrl);
        if (src) collector.add(src, 'js');
    });

    // --- Images ---
    $('img[src]').each((i, el) => {
        const src = resolveUrl($(el).attr('src'), baseUrl);
        if (src) collector.add(src, 'images');
    });

    // --- Image srcset ---
    $('img[srcset], source[srcset]').each((i, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
            srcset.split(',').forEach(s => {
                const parts = s.trim().split(/\s+/);
                if (parts[0]) {
                    const src = resolveUrl(parts[0], baseUrl);
                    if (src) collector.add(src, 'images');
                }
            });
        }
    });

    // --- Source elements (picture, video, audio) ---
    $('source[src]').each((i, el) => {
        const src = resolveUrl($(el).attr('src'), baseUrl);
        if (src) {
            const type = classifyAssetByUrl(src) || 'media';
            collector.add(src, type);
        }
    });

    // --- Video ---
    $('video[src]').each((i, el) => {
        const src = resolveUrl($(el).attr('src'), baseUrl);
        if (src) collector.add(src, 'media');
    });
    $('video[poster]').each((i, el) => {
        const poster = resolveUrl($(el).attr('poster'), baseUrl);
        if (poster) collector.add(poster, 'images');
    });

    // --- Audio ---
    $('audio[src]').each((i, el) => {
        const src = resolveUrl($(el).attr('src'), baseUrl);
        if (src) collector.add(src, 'media');
    });

    // --- Favicons & Icons ---
    $('link[rel="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]').each((i, el) => {
        const href = resolveUrl($(el).attr('href'), baseUrl);
        if (href) collector.add(href, 'images');
    });

    // --- Preloaded fonts ---
    $('link[rel="preload"][as="font"][href]').each((i, el) => {
        const href = resolveUrl($(el).attr('href'), baseUrl);
        if (href) collector.add(href, 'fonts');
    });

    // --- Preloaded images ---
    $('link[rel="preload"][as="image"][href]').each((i, el) => {
        const href = resolveUrl($(el).attr('href'), baseUrl);
        if (href) collector.add(href, 'images');
    });

    // --- Open Graph / Meta images ---
    $('meta[property="og:image"][content], meta[name="twitter:image"][content]').each((i, el) => {
        const content = resolveUrl($(el).attr('content'), baseUrl);
        if (content) collector.add(content, 'images');
    });

    // --- Inline style background-image URLs ---
    $('[style]').each((i, el) => {
        const style = $(el).attr('style');
        if (style) {
            const urlMatches = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
            if (urlMatches) {
                urlMatches.forEach(match => {
                    const inner = match.replace(/url\(\s*['"]?/i, '').replace(/['"]?\s*\)/i, '');
                    const resolved = resolveUrl(inner, baseUrl);
                    if (resolved) {
                        const type = classifyAssetByUrl(resolved) || 'images';
                        collector.add(resolved, type);
                    }
                });
            }
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  EXTRACT ASSETS FROM CSS CONTENT
// ═══════════════════════════════════════════════════════════════
function extractAssetsFromCSS(cssContent, cssUrl, collector) {
    if (!cssContent || typeof cssContent !== 'string') return;

    // Match all url() references in CSS
    const urlRegex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi;
    let match;
    while ((match = urlRegex.exec(cssContent)) !== null) {
        let rawUrl = match[1].trim();

        // Skip data URIs and fragments
        if (rawUrl.startsWith('data:') || rawUrl.startsWith('#') || rawUrl.startsWith('blob:')) continue;

        const resolved = resolveUrl(rawUrl, cssUrl);
        if (resolved) {
            const type = classifyAssetByUrl(resolved) || 'images';
            collector.add(resolved, type);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  REWRITE HTML URLs TO LOCAL PATHS
// ═══════════════════════════════════════════════════════════════
function rewriteHTMLUrls($, baseUrl, collector, htmlLocalDir) {
    const rewrite = (absUrl) => {
        const localPath = collector.getLocalPath(absUrl);
        if (!localPath) return absUrl; // Keep original if not collected
        // Compute relative path from the HTML file's directory
        return computeRelativePath(htmlLocalDir, localPath);
    };

    const resolveAndRewrite = (rawUrl) => {
        const abs = resolveUrl(rawUrl, baseUrl);
        if (!abs) return rawUrl;
        return rewrite(abs);
    };

    // Stylesheets
    $('link[rel="stylesheet"][href], link[type="text/css"][href]').each((i, el) => {
        $(el).attr('href', resolveAndRewrite($(el).attr('href')));
    });

    // Preloaded stylesheets
    $('link[rel="preload"][as="style"][href]').each((i, el) => {
        $(el).attr('href', resolveAndRewrite($(el).attr('href')));
    });

    // Scripts
    $('script[src]').each((i, el) => {
        $(el).attr('src', resolveAndRewrite($(el).attr('src')));
    });

    // Images
    $('img[src]').each((i, el) => {
        $(el).attr('src', resolveAndRewrite($(el).attr('src')));
    });

    // Srcsets
    $('img[srcset], source[srcset]').each((i, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
            const newSrcset = srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                if (parts[0]) {
                    parts[0] = resolveAndRewrite(parts[0]);
                }
                return parts.join(' ');
            }).join(', ');
            $(el).attr('srcset', newSrcset);
        }
    });

    // Source elements
    $('source[src]').each((i, el) => {
        $(el).attr('src', resolveAndRewrite($(el).attr('src')));
    });

    // Video
    $('video[src]').each((i, el) => {
        $(el).attr('src', resolveAndRewrite($(el).attr('src')));
    });
    $('video[poster]').each((i, el) => {
        $(el).attr('poster', resolveAndRewrite($(el).attr('poster')));
    });

    // Audio
    $('audio[src]').each((i, el) => {
        $(el).attr('src', resolveAndRewrite($(el).attr('src')));
    });

    // Favicons & Icons
    $('link[rel="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]').each((i, el) => {
        $(el).attr('href', resolveAndRewrite($(el).attr('href')));
    });

    // Preloaded fonts
    $('link[rel="preload"][as="font"][href]').each((i, el) => {
        $(el).attr('href', resolveAndRewrite($(el).attr('href')));
    });

    // Preloaded images
    $('link[rel="preload"][as="image"][href]').each((i, el) => {
        $(el).attr('href', resolveAndRewrite($(el).attr('href')));
    });

    // OG images
    $('meta[property="og:image"][content]').each((i, el) => {
        $(el).attr('content', resolveAndRewrite($(el).attr('content')));
    });
    $('meta[name="twitter:image"][content]').each((i, el) => {
        $(el).attr('content', resolveAndRewrite($(el).attr('content')));
    });

    // Inline styles with url()
    $('[style]').each((i, el) => {
        let style = $(el).attr('style');
        if (style) {
            style = style.replace(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi, (fullMatch, rawUrl) => {
                const resolved = resolveUrl(rawUrl, baseUrl);
                if (resolved) {
                    const local = rewrite(resolved);
                    return `url('${local}')`;
                }
                return fullMatch;
            });
            $(el).attr('style', style);
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  REWRITE CSS url() TO LOCAL PATHS
// ═══════════════════════════════════════════════════════════════
function rewriteCSSUrls(cssContent, cssUrl, collector, cssLocalPath) {
    if (!cssContent || typeof cssContent !== 'string') return cssContent;

    const cssDir = path.dirname(cssLocalPath);

    return cssContent.replace(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi, (fullMatch, rawUrl) => {
        if (rawUrl.startsWith('data:') || rawUrl.startsWith('#') || rawUrl.startsWith('blob:')) {
            return fullMatch;
        }
        const resolved = resolveUrl(rawUrl, cssUrl);
        if (!resolved) return fullMatch;

        const localPath = collector.getLocalPath(resolved);
        if (!localPath) return fullMatch;

        const relativePath = computeRelativePath(cssDir, localPath);
        return `url('${relativePath}')`;
    });
}

// ═══════════════════════════════════════════════════════════════
//  PATH UTILS
// ═══════════════════════════════════════════════════════════════
function computeRelativePath(fromDir, toPath) {
    // Both are paths like "css/style.css" or "index.html" or "blog/post.html"
    // fromDir: the directory containing the referencing file
    // toPath: the target asset's local path
    const from = fromDir.replace(/\\/g, '/');
    const to = toPath.replace(/\\/g, '/');

    const fromParts = from ? from.split('/').filter(Boolean) : [];
    const toParts = to.split('/').filter(Boolean);

    // Find common prefix length
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
        common++;
    }

    const upSteps = fromParts.length - common;
    const downParts = toParts.slice(common);

    const result = [...Array(upSteps).fill('..'), ...downParts].join('/');
    return result || toPath;
}

// ═══════════════════════════════════════════════════════════════
//  DOWNLOAD HELPERS
// ═══════════════════════════════════════════════════════════════
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function fetchPage(targetUrl) {
    try {
        console.log(`  [Snapshot] Capturing fully rendered HTML for: ${targetUrl}`);
        const html = await captureSnapshot(targetUrl);
        return html;
    } catch (err) {
        console.warn(`  [Snapshot] Failed to capture snapshot, falling back to raw HTML for: ${targetUrl}`);
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 20000,
            responseType: 'text',
        });
        return response.data;
    }
}

async function downloadAsset(url, timeout = 30000) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': '*/*',
                'Referer': url,
            },
            timeout,
            responseType: 'arraybuffer',
            maxRedirects: 5,
        });
        return {
            buffer: Buffer.from(response.data),
            contentType: response.headers['content-type'] || '',
        };
    } catch (err) {
        console.warn(`  ⚠ Failed to download asset: ${url} — ${err.message}`);
        return null;
    }
}

/**
 * Download assets in parallel batches to avoid overwhelming servers
 */
async function downloadAllAssets(collector, batchSize = 10) {
    const allAssets = collector.getAll().filter(a => !a.downloaded);
    console.log(`📦 Downloading ${allAssets.length} assets...`);

    for (let i = 0; i < allAssets.length; i += batchSize) {
        const batch = allAssets.slice(i, i + batchSize);
        const promises = batch.map(async (asset) => {
            const result = await downloadAsset(asset.url);
            if (result) {
                collector.setBuffer(asset.url, result.buffer);

                // If it's a CSS file, parse it for more assets (fonts, bg images)
                if (asset.type === 'css') {
                    try {
                        const cssText = result.buffer.toString('utf-8');
                        extractAssetsFromCSS(cssText, asset.url, collector);
                    } catch (e) {
                        console.warn(`  ⚠ Could not parse CSS from ${asset.url}: ${e.message}`);
                    }
                }
            }
        });
        await Promise.all(promises);
    }

    // Second pass: download any NEW assets discovered inside CSS files
    const newAssets = collector.getAll().filter(a => !a.downloaded);
    if (newAssets.length > 0) {
        console.log(`📦 Downloading ${newAssets.length} additional assets discovered in CSS...`);
        for (let i = 0; i < newAssets.length; i += batchSize) {
            const batch = newAssets.slice(i, i + batchSize);
            await Promise.all(batch.map(async (asset) => {
                const result = await downloadAsset(asset.url);
                if (result) collector.setBuffer(asset.url, result.buffer);
            }));
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  MAKE URLs ABSOLUTE (for single-page mode only)
// ═══════════════════════════════════════════════════════════════
function makeUrlsAbsolute($, baseUrl) {
    const resolve = (currentUrl) => resolveUrl(currentUrl, baseUrl) || currentUrl;

    $('link[href]').each((i, el) => $(el).attr('href', resolve($(el).attr('href'))));
    $('script[src]').each((i, el) => $(el).attr('src', resolve($(el).attr('src'))));
    $('img[src], source[src]').each((i, el) => $(el).attr('src', resolve($(el).attr('src'))));
    $('img[srcset], source[srcset]').each((i, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
            const newSrcset = srcset.split(',').map(s => {
                const parts = s.trim().split(' ');
                if (parts[0]) parts[0] = resolve(parts[0]);
                return parts.join(' ');
            }).join(', ');
            $(el).attr('srcset', newSrcset);
        }
    });
    $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.startsWith('/')) $(el).attr('href', resolve(href));
    });
}

// ═══════════════════════════════════════════════════════════════
//  DETERMINE HTML LOCAL PATH (for URL rewriting context)
// ═══════════════════════════════════════════════════════════════
function getHtmlLocalPath(checkUrl, parsedBaseOrigin) {
    let pathName;
    try {
        pathName = new URL(checkUrl).pathname;
    } catch {
        pathName = '/';
    }

    if (pathName === '' || pathName === '/') {
        return 'index.html';
    }

    if (!pathName.endsWith('.html')) {
        if (pathName.endsWith('/')) {
            pathName = pathName + 'index.html';
        } else {
            pathName = pathName + '.html';
        }
    }
    if (pathName.startsWith('/')) {
        pathName = pathName.slice(1);
    }

    return pathName;
}

// ═══════════════════════════════════════════════════════════════
//  SSE PROGRESS ENDPOINT
// ═══════════════════════════════════════════════════════════════
const exportProgress = new Map(); // exportId → { status, pagesFound, pagesProcessed, assetsFound, assetsDownloaded }

app.get('/api/export/progress/:id', (req, res) => {
    const id = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const interval = setInterval(() => {
        const progress = exportProgress.get(id);
        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
            if (progress.status === 'done' || progress.status === 'error') {
                clearInterval(interval);
                exportProgress.delete(id);
                res.end();
            }
        }
    }, 500);

    req.on('close', () => {
        clearInterval(interval);
    });
});

// ═══════════════════════════════════════════════════════════════
//  SINGLE PAGE EXPORT (original — keeps absolute URLs)
// ═══════════════════════════════════════════════════════════════
app.post('/api/export/single', async (req, res) => {
    try {
        let { targetUrl } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        const parsedUrl = new URL(targetUrl);
        const finalUrl = parsedUrl.href;

        const html = await fetchPage(finalUrl);
        const $ = cheerio.load(html);

        makeUrlsAbsolute($, finalUrl);
        removeWatermarks($);
        const cleanHtml = $.html();
        const hostname = parsedUrl.hostname.replace('www.', '');

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-export.html"`);
        return res.send(cleanHtml);

    } catch (err) {
        console.error('Single Export Error:', err.message);
        const errorMsg = err.response ? `HTTP ${err.response.status}` : err.message;
        return res.status(500).json({ error: `Failed to fetch website: ${errorMsg}` });
    }
});

// ═══════════════════════════════════════════════════════════════
//  FULL SITE ZIP EXPORT — COMPLETE ASSET EXTRACTION
// ═══════════════════════════════════════════════════════════════
app.post('/api/export/zip', async (req, res) => {
    const exportId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    try {
        let { targetUrl } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        const parsedUrl = new URL(targetUrl);
        const baseUrl = parsedUrl.origin;
        const hostname = parsedUrl.hostname.replace('www.', '');

        // Initialize progress tracking
        exportProgress.set(exportId, {
            status: 'crawling',
            pagesFound: 0,
            pagesProcessed: 0,
            assetsFound: 0,
            assetsDownloaded: 0,
            exportId,
        });

        console.log(`\n🚀 Starting full export of ${hostname}...`);

        // Create asset collector
        const collector = new AssetCollector();

        // ── Phase 1: Crawl all pages ──────────────────────────
        const visited = new Set();
        const queue = [parsedUrl.href];
        const pageData = []; // { url, html, localPath }
        const MAX_PAGES = 50;

        while (queue.length > 0 && pageData.length < MAX_PAGES) {
            const currentUrl = queue.shift();

            let checkUrl = currentUrl.split('#')[0];
            if (checkUrl.endsWith('/') && checkUrl !== baseUrl + '/') {
                checkUrl = checkUrl.slice(0, -1);
            }

            if (visited.has(checkUrl)) continue;
            visited.add(checkUrl);

            try {
                console.log(`  📄 Crawling: ${currentUrl}`);
                const html = await fetchPage(currentUrl);

                const $ = cheerio.load(html);

                // Discover internal links
                $('a[href]').each((i, el) => {
                    let href = $(el).attr('href');
                    if (href) {
                        try {
                            const linkUrl = new URL(href, baseUrl);
                            if (
                                linkUrl.origin === baseUrl &&
                                !href.match(/\.(png|jpg|jpeg|gif|css|js|pdf|zip|svg|webp|mp4|mp3|woff2?)$/i) &&
                                !linkUrl.hash
                            ) {
                                queue.push(linkUrl.href);
                            }
                        } catch {}
                    }
                });

                // Extract assets from this page
                extractAssetsFromHTML($, currentUrl, collector);

                // Remove watermarks
                removeWatermarks($);

                const localPath = getHtmlLocalPath(checkUrl, baseUrl);

                pageData.push({
                    url: currentUrl,
                    checkUrl,
                    $, // Keep parsed DOM for later URL rewriting
                    localPath,
                });

                // Update progress
                const progress = exportProgress.get(exportId);
                if (progress) {
                    progress.pagesFound = visited.size;
                    progress.pagesProcessed = pageData.length;
                    progress.assetsFound = collector.getAll().length;
                }

            } catch (pageErr) {
                console.warn(`  ⚠ Failed to crawl ${currentUrl}: ${pageErr.message}`);
            }
        }

        console.log(`\n✅ Crawled ${pageData.length} pages. Found ${collector.getAll().length} assets.`);

        // ── Phase 2: Download all assets ──────────────────────
        const progress = exportProgress.get(exportId);
        if (progress) {
            progress.status = 'downloading';
            progress.assetsFound = collector.getAll().length;
        }

        await downloadAllAssets(collector, 10);

        // Count downloaded
        const downloadedCount = collector.getAll().filter(a => a.downloaded).length;
        console.log(`\n✅ Downloaded ${downloadedCount}/${collector.getAll().length} assets.`);

        if (progress) {
            progress.status = 'packaging';
            progress.assetsDownloaded = downloadedCount;
        }

        // ── Phase 2.5: AI Intelligence Extraction ─────────────
        const aiAnalyzer = require('./ai-analyzer');
        const firstPageHtml = pageData.length > 0 ? pageData[0].$.html() : '';
        const cssContentsForAI = collector.getAllByType('css')
            .filter(a => a.downloaded && a.buffer)
            .map(a => a.buffer.toString('utf-8'))
            .join('\n');
        
        let aiReports = null;
        if (firstPageHtml) {
            console.log(`\n🧠 Generating AI Intelligence Reports...`);
            if (progress) progress.status = 'analyzing';
            aiReports = await aiAnalyzer.analyzeWebsite(firstPageHtml, cssContentsForAI, targetUrl);
        }

        // ── Phase 3: Rewrite URLs and build ZIP ───────────────
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-full-export.zip"`);
        res.setHeader('X-Export-Id', exportId);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('warning', (err) => { if (err.code !== 'ENOENT') throw err; });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);

        // Add HTML pages with rewritten URLs
        for (const page of pageData) {
            const htmlDir = path.dirname(page.localPath).replace(/\\/g, '/');
            const dirForRelative = htmlDir === '.' ? '' : htmlDir;
            rewriteHTMLUrls(page.$, page.url, collector, dirForRelative);

            const finalHtml = page.$.html();
            archive.append(finalHtml, { name: page.localPath });
            console.log(`  📄 Added: ${page.localPath}`);
        }

        // Add CSS files with rewritten URLs
        for (const asset of collector.getAllByType('css')) {
            if (asset.downloaded && asset.buffer) {
                let cssContent = asset.buffer.toString('utf-8');
                cssContent = rewriteCSSUrls(cssContent, asset.url, collector, asset.localPath);
                archive.append(Buffer.from(cssContent, 'utf-8'), { name: asset.localPath });
                console.log(`  🎨 Added: ${asset.localPath}`);
            }
        }

        // Add JS files
        for (const asset of collector.getAllByType('js')) {
            if (asset.downloaded && asset.buffer) {
                archive.append(asset.buffer, { name: asset.localPath });
                console.log(`  ⚡ Added: ${asset.localPath}`);
            }
        }

        // Add images
        for (const asset of collector.getAllByType('images')) {
            if (asset.downloaded && asset.buffer) {
                archive.append(asset.buffer, { name: asset.localPath });
            }
        }
        const imgCount = collector.getAllByType('images').filter(a => a.downloaded).length;
        if (imgCount > 0) console.log(`  🖼️ Added: ${imgCount} images`);

        // Add fonts
        for (const asset of collector.getAllByType('fonts')) {
            if (asset.downloaded && asset.buffer) {
                archive.append(asset.buffer, { name: asset.localPath });
            }
        }
        const fontCount = collector.getAllByType('fonts').filter(a => a.downloaded).length;
        if (fontCount > 0) console.log(`  🔤 Added: ${fontCount} fonts`);

        // Add media
        for (const asset of collector.getAllByType('media')) {
            if (asset.downloaded && asset.buffer) {
                archive.append(asset.buffer, { name: asset.localPath });
            }
        }
        const mediaCount = collector.getAllByType('media').filter(a => a.downloaded).length;
        if (mediaCount > 0) console.log(`  🎬 Added: ${mediaCount} media files`);

        // Add AI Analysis Reports
        if (aiReports) {
            if (aiReports.error) {
                console.log(`  ⚠️ AI Analysis failed, adding error log to ZIP`);
                archive.append(aiReports.error, { name: 'analysis/analysis-error.txt' });
            } else {
                console.log(`  🧠 Added AI Analysis Reports to ZIP`);
                archive.append(aiReports.designSystem, { name: 'analysis/design-system.json' });
                archive.append(aiReports.funnelMapping, { name: 'analysis/funnel-mapping.md' });
                archive.append(aiReports.frontendPsychology, { name: 'analysis/frontend-psychology.md' });
                archive.append(aiReports.uxBreakdown, { name: 'analysis/ux-ui-breakdown.md' });
            }
        }

        // Add a README
        const readme = `# ${hostname} — Full Site Export
Generated by FreeHTML.pro on ${new Date().toISOString().split('T')[0]}

## Contents
- ${pageData.length} HTML pages
- ${collector.counters.css || 0} CSS stylesheets
- ${collector.counters.js || 0} JavaScript files
- ${collector.counters.images || 0} images
- ${collector.counters.fonts || 0} fonts
- ${collector.counters.media || 0} media files

## How to Host
1. Upload the contents of this ZIP to any web server (Netlify, Vercel, GitHub Pages, Apache, Nginx, etc.)
2. Open index.html in your browser — everything works offline!

## Notes
- All URLs have been rewritten to use local relative paths
- No external CDN dependencies for assets
- Watermarks from the original platform have been removed
`;
        archive.append(readme, { name: 'README.md' });

        await archive.finalize();

        console.log(`\n🎉 Export complete! ZIP sent to client.`);
        if (progress) progress.status = 'done';

    } catch (err) {
        console.error('ZIP Export Error:', err.message);
        const progress = exportProgress.get(exportId);
        if (progress) progress.status = 'error';

        if (!res.headersSent) {
            return res.status(500).json({ error: `ZIP Export Failed: ${err.message}`, exportId });
        }
    }
});


// ═══════════════════════════════════════════════════════════════
//  SINGLE PAGE FULL EXPORT (new — downloads assets locally)  
// ═══════════════════════════════════════════════════════════════
app.post('/api/export/single-full', async (req, res) => {
    try {
        let { targetUrl } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });

        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        const parsedUrl = new URL(targetUrl);
        const finalUrl = parsedUrl.href;
        const hostname = parsedUrl.hostname.replace('www.', '');

        console.log(`\n🚀 Starting single-page full export of ${hostname}...`);

        const html = await fetchPage(finalUrl);
        const $ = cheerio.load(html);

        const collector = new AssetCollector();
        extractAssetsFromHTML($, finalUrl, collector);
        removeWatermarks($);

        console.log(`  Found ${collector.getAll().length} assets on the page.`);

        // Download everything
        await downloadAllAssets(collector, 10);

        const downloadedCount = collector.getAll().filter(a => a.downloaded).length;
        console.log(`  Downloaded ${downloadedCount} assets.`);

        // Rewrite HTML
        rewriteHTMLUrls($, finalUrl, collector, '');

        // Build ZIP
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-export.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('warning', (err) => { if (err.code !== 'ENOENT') throw err; });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);

        // Add HTML
        archive.append($.html(), { name: 'index.html' });

        // Add CSS with rewritten URLs
        for (const asset of collector.getAllByType('css')) {
            if (asset.downloaded && asset.buffer) {
                let cssContent = asset.buffer.toString('utf-8');
                cssContent = rewriteCSSUrls(cssContent, asset.url, collector, asset.localPath);
                archive.append(Buffer.from(cssContent, 'utf-8'), { name: asset.localPath });
            }
        }

        // Add all other assets
        for (const asset of collector.getAll()) {
            if (asset.downloaded && asset.buffer && asset.type !== 'css') {
                archive.append(asset.buffer, { name: asset.localPath });
            }
        }

        await archive.finalize();
        console.log(`\n🎉 Single-page full export complete!`);

    } catch (err) {
        console.error('Single-Full Export Error:', err.message);
        if (!res.headersSent) {
            return res.status(500).json({ error: `Export Failed: ${err.message}` });
        }
    }
});


// ═══════════════════════════════════════════════════════════════
//  NEXT.JS PROJECT EXPORT — Full React/Next.js Conversion
// ═══════════════════════════════════════════════════════════════
app.post('/api/export/nextjs', async (req, res) => {
    try {
        let { targetUrl, exportMode = 'ssr', language = 'ts' } = req.body;
        if (!targetUrl) return res.status(400).json({ error: 'URL is required' });
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
        if (!['static', 'ssr'].includes(exportMode)) exportMode = 'ssr';
        if (!['ts', 'js'].includes(language)) language = 'ts';

        const parsedUrl = new URL(targetUrl);
        const baseUrl = parsedUrl.origin;
        const hostname = parsedUrl.hostname.replace('www.', '');

        console.log(`\n🚀 Starting Next.js conversion for ${hostname}...`);

        const collector = new AssetCollector();
        const visited = new Set();
        const queue = [parsedUrl.href];
        const pageData = [];
        const MAX_PAGES = 50;

        // Phase 1: Crawl
        while (queue.length > 0 && pageData.length < MAX_PAGES) {
            const currentUrl = queue.shift();
            let checkUrl = currentUrl.split('#')[0];
            if (checkUrl.endsWith('/') && checkUrl !== baseUrl + '/') checkUrl = checkUrl.slice(0, -1);
            if (visited.has(checkUrl)) continue;
            visited.add(checkUrl);

            try {
                console.log(`  📄 Crawling: ${currentUrl}`);
                const html = await fetchPage(currentUrl);
                const $ = cheerio.load(html);

                $('a[href]').each((i, el) => {
                    let href = $(el).attr('href');
                    if (href) {
                        try {
                            const linkUrl = new URL(href, baseUrl);
                            if (linkUrl.origin === baseUrl && !href.match(/\.(png|jpg|jpeg|gif|css|js|pdf|zip|svg|webp|mp4|woff2?)$/i) && !linkUrl.hash) {
                                queue.push(linkUrl.href);
                            }
                        } catch {}
                    }
                });

                extractAssetsFromHTML($, currentUrl, collector);
                removeWatermarks($);
                pageData.push({ url: currentUrl, checkUrl, $ });
            } catch (e) {
                console.warn(`  ⚠ Failed: ${currentUrl}: ${e.message}`);
            }
        }

        console.log(`  ✅ Crawled ${pageData.length} pages, found ${collector.getAll().length} assets`);

        // Phase 2: Download assets
        await downloadAllAssets(collector, 10);
        const downloaded = collector.getAll().filter(a => a.downloaded).length;
        console.log(`  ✅ Downloaded ${downloaded} assets`);

        // Phase 3: Detect platform + run converters
        const firstHtml = pageData[0] ? pageData[0].$.html() : '';
        const detection = detectPlatform(firstHtml);
        console.log(`  🔍 Detected platform: ${detection.platform} (confidence: ${detection.confidence})`);

        // Form conversion — run on all pages
        const allFormComponents = [];
        let serverAction = null;
        for (const page of pageData) {
            const formResult = convertForms(page.$, exportMode);
            allFormComponents.push(...formResult.components);
            if (formResult.serverAction && !serverAction) serverAction = formResult.serverAction;
        }

        // Design token extraction from downloaded CSS
        const cssContents = collector.getAllByType('css')
            .filter(a => a.downloaded && a.buffer)
            .map(a => a.buffer.toString('utf8'));
        const tokens = extractTokens(cssContents);
        const tailwindConfig = buildTailwindConfig(tokens);

        console.log(`  ⚛️ Converting to Next.js (${detection.platform}, ${exportMode}, ${language})...`);
        const options = { exportMode, language, platform: detection.platform };

        let projectFiles;
        if (detection.platform === 'framer') {
            projectFiles = convertFramerToNextJS(pageData, collector, hostname, options);
        } else {
            projectFiles = convertToNextJS(pageData, collector, hostname, options);
        }

        // Inject form components
        allFormComponents.forEach((comp, i) => {
            projectFiles.push({
                path: `components/Form${i > 0 ? i : ''}.${language === 'ts' ? 'tsx' : 'jsx'}`,
                content: comp,
                isBinary: false,
            });
        });
        if (serverAction) {
            projectFiles.push({ path: 'app/actions.ts', content: serverAction, isBinary: false });
        }

        // Inject Tailwind config
        projectFiles.push({ path: 'tailwind.config.ts', content: tailwindConfig, isBinary: false });

        // Phase 4: Package as ZIP
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${hostname}-nextjs.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('warning', (err) => { if (err.code !== 'ENOENT') throw err; });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);

        for (const file of projectFiles) {
            if (file.isBinary) {
                archive.append(file.content, { name: file.path });
            } else {
                archive.append(file.content, { name: file.path });
            }
        }

        await archive.finalize();
        console.log(`  🎉 Next.js project export complete!`);

    } catch (err) {
        console.error('Next.js Export Error:', err.message);
        if (!res.headersSent) {
            return res.status(500).json({ error: `Next.js Export Failed: ${err.message}` });
        }
    }
});


// ═══════════════════════════════════════════════════════════════
//  PREVIEW PROXY (for Figma export)
// ═══════════════════════════════════════════════════════════════
app.get('/api/export/preview', async (req, res) => {
    try {
        let { targetUrl } = req.query;
        if (!targetUrl) return res.status(400).send('URL is required');

        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        const html = await fetchPage(targetUrl);
        const $ = cheerio.load(html);

        makeUrlsAbsolute($, targetUrl);
        removeWatermarks($);

        res.setHeader('Content-Type', 'text/html');
        return res.send($.html());
    } catch (err) {
        console.error('Preview Export Error:', err.message);
        return res.status(500).send(`Export Failed: ${err.message}`);
    }
});

const port = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
    const server = app.listen(port, () => {
        console.log(`🚀 Export Server running on http://localhost:${port}`);
    }).on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use.`);
            process.exit(1);
        }
    });
}

module.exports = app;

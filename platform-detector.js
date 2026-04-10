// ═══════════════════════════════════════════════════════════════
//  PLATFORM DETECTOR
//  Fingerprints HTML to identify Framer vs Webflow
// ═══════════════════════════════════════════════════════════════

/**
 * @param {string} html - Raw HTML string from the first fetched page
 * @returns {{ platform: 'framer' | 'webflow' | 'unknown', confidence: number, signals: string[] }}
 */
function detectPlatform(html) {
    const framerSignals = [];
    const webflowSignals = [];

    // Framer signals
    if (html.includes('data-framer-name') || html.includes('data-framer-component')) {
        framerSignals.push('data-framer-name/component attribute');
    }
    if (html.includes('framer.com') || html.includes('framerusercontent.com')) {
        framerSignals.push('framer.com script src');
    }
    if (html.includes('__framerLoaded') || html.includes('FramerConfig') || html.includes('window.Framer')) {
        framerSignals.push('Framer global in inline script');
    }
    if (/<meta[^>]+name=["']generator["'][^>]+content=["']Framer["']/i.test(html)) {
        framerSignals.push('meta generator=Framer');
    }
    if (html.includes('data-framer-appear') || html.includes('data-framer-motion')) {
        framerSignals.push('data-framer-appear/motion attribute');
    }

    // Webflow signals
    if (html.includes('data-wf-page') || html.includes('data-wf-site')) {
        webflowSignals.push('data-wf-page/site attribute');
    }
    if (html.includes('webflow.com') || html.includes('assets.website-files.com')) {
        webflowSignals.push('webflow.com script src');
    }
    if (html.includes('data-wf-') && html.indexOf('data-wf-') !== html.lastIndexOf('data-wf-')) {
        webflowSignals.push('multiple data-wf-* attributes');
    }
    if (html.includes('"ix2":{') || html.includes('"ix2": {')) {
        webflowSignals.push('IX2 interaction JSON');
    }

    if (framerSignals.length >= 2) {
        return { platform: 'framer', confidence: framerSignals.length, signals: framerSignals };
    }
    if (webflowSignals.length >= 2) {
        return { platform: 'webflow', confidence: webflowSignals.length, signals: webflowSignals };
    }
    if (framerSignals.length > webflowSignals.length) {
        return { platform: 'framer', confidence: framerSignals.length, signals: framerSignals };
    }
    if (webflowSignals.length > framerSignals.length) {
        return { platform: 'webflow', confidence: webflowSignals.length, signals: webflowSignals };
    }
    return { platform: 'unknown', confidence: 0, signals: [] };
}

module.exports = { detectPlatform };

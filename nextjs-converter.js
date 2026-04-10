// ═══════════════════════════════════════════════════════════════
//  NEXT.JS CONVERTER ENGINE
//  Converts crawled HTML pages + assets into a full Next.js project
// ═══════════════════════════════════════════════════════════════

const cheerio = require('cheerio');
const path = require('path');

// ── HTML Attribute → JSX Attribute mapping ──────────────────
const ATTR_MAP = {
    'class': 'className',
    'for': 'htmlFor',
    'tabindex': 'tabIndex',
    'readonly': 'readOnly',
    'maxlength': 'maxLength',
    'cellpadding': 'cellPadding',
    'cellspacing': 'cellSpacing',
    'rowspan': 'rowSpan',
    'colspan': 'colSpan',
    'frameborder': 'frameBorder',
    'allowfullscreen': 'allowFullScreen',
    'autocomplete': 'autoComplete',
    'autofocus': 'autoFocus',
    'autoplay': 'autoPlay',
    'enctype': 'encType',
    'formaction': 'formAction',
    'novalidate': 'noValidate',
    'crossorigin': 'crossOrigin',
    'srcset': 'srcSet',
    'charset': 'charSet',
    'accesskey': 'accessKey',
    'contenteditable': 'contentEditable',
    'contextmenu': 'contextMenu',
    'datetime': 'dateTime',
    'hreflang': 'hrefLang',
    'inputmode': 'inputMode',
    'mediagroup': 'mediaGroup',
    'minlength': 'minLength',
    'spellcheck': 'spellCheck',
    'usemap': 'useMap',
    'formmethod': 'formMethod',
    'formtarget': 'formTarget',
    'formnovalidate': 'formNoValidate',
    'playsinline': 'playsInline',
    'muted': 'muted',
    'loop': 'loop',
    'playsinline': 'playsInline',
    'webkit-playsinline': 'playsInline'
};

// Self-closing HTML tags that need /> in JSX
const SELF_CLOSING = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// ── Convert inline style string → React style object string ──
function convertStyleString(styleStr) {
    if (!styleStr || !styleStr.trim()) return null;
    
    try {
        const pairs = [];
        // Split on ; but handle url() contents
        const parts = styleStr.split(/;(?![^(]*\))/);
        
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx === -1) continue;
            
            let prop = trimmed.substring(0, colonIdx).trim();
            let val = trimmed.substring(colonIdx + 1).trim();
            
            // Convert kebab-case to camelCase
            prop = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            
            // Handle vendor prefixes
            if (prop.startsWith('-webkit')) prop = 'WebKit' + prop.slice(7);
            if (prop.startsWith('-moz')) prop = 'Moz' + prop.slice(4);
            if (prop.startsWith('-ms')) prop = 'ms' + prop.slice(3);
            
            pairs.push(`'${prop}': ${JSON.stringify(val)}`);
        }
        
        if (pairs.length === 0) return null;
        return `{{ ${pairs.join(', ')} }}`;
    } catch {
        return `{{ cssText: '${styleStr.replace(/'/g, "\\'")}' }}`;
    }
}

// ── Convert raw HTML string to JSX-safe string ──────────────
function htmlToJsx(htmlStr) {
    if (!htmlStr) return '';
    
    let jsx = htmlStr;

    // 0a) Fix malformed Webflow attributes: attr=""="value" → attr="value"
    //     Webflow sometimes exports srcset/sizes with a broken double-quote pattern
    jsx = jsx.replace(/(\w+)=""="([^"]*)"/g, '$1="$2"');
    
    // 0b) Remove data-srcset and data-sizes (Webflow duplicates of srcset/sizes)
    jsx = jsx.replace(/\s+data-srcset="[^"]*"/g, '');
    jsx = jsx.replace(/\s+data-sizes="[^"]*"/g, '');

    // 0d) Remove Framer runtime-only attributes that contain raw JSON with inner quotes.
    //     These attributes break JSX parsing and are not used by React at all.
    jsx = jsx.replace(/\s+data-framer-hydrate-v2="[^"]*"/g, '');
    jsx = jsx.replace(/\s+data-framer-hydrate-v2='[\s\S]*?'/g, '');
    jsx = jsx.replace(/\s+data-framer-ssr-released-at="[^"]*"/g, '');
    jsx = jsx.replace(/\s+data-framer-page-optimized-at="[^"]*"/g, '');
    jsx = jsx.replace(/\s+data-framer-generated-page(?:="[^"]*")?/g, '');
    
    // 0c) Collapse multi-line data-wf-* attribute values into single lines
    //    The GraphQL query in data-wf-cart-query spans many lines and causes hydration mismatch
    jsx = jsx.replace(/data-wf-cart-query="([^"]*)"/gs, (m) => m.replace(/\n/g, ' ').replace(/\s+/g, ' '));
    jsx = jsx.replace(/data-wf-bindings="([^"]*)"/gs, (m) => m.replace(/\n/g, ' ').replace(/\s+/g, ' '));
    jsx = jsx.replace(/data-wf-conditions="([^"]*)"/gs, (m) => m.replace(/\n/g, ' ').replace(/\s+/g, ' '));
    jsx = jsx.replace(/data-wf-target="([^"]*)"/gs, (m) => m.replace(/\n/g, ' ').replace(/\s+/g, ' '));

    
    // 1) Convert HTML comments to JSX comments
    jsx = jsx.replace(/<!--([\s\S]*?)-->/g, '{/* $1 */}');
    
    // 2) Convert self-closing tags
    for (const tag of SELF_CLOSING) {
        const regex = new RegExp(`<(${tag})(\\s[^>]*)?>(?!\\s*<\\/${tag})`, 'gi');
        jsx = jsx.replace(regex, (match, tagName, attrs) => {
            attrs = attrs || '';
            if (attrs.endsWith('/')) return match;
            return `<${tagName}${attrs} />`;
        });
    }
    
    // 3) Strip XML namespace attributes that are NOT valid JSX
    //    xmlns:xlink, xmlns:svg, xlink:href (replace with href), xlink:*, etc.
    //    These cause the "JSX Namespace is disabled" error.
    jsx = jsx.replace(/\s+xmlns:[a-zA-Z][a-zA-Z0-9]*="[^"]*"/g, '');
    jsx = jsx.replace(/\s+xmlns:[a-zA-Z][a-zA-Z0-9]*='[^']*'/g, '');
    // xlink:href → href (React supports this as href)
    jsx = jsx.replace(/\bxlink:href=/g, 'href=');
    // Remove any remaining namespace-qualified attributes (e.g. xlink:*, xml:*, etc.)
    jsx = jsx.replace(/\s+[a-zA-Z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9]*="[^"]*"/g, '');
    jsx = jsx.replace(/\s+[a-zA-Z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9]*='[^']*'/g, '');
    
    // Replace special characters that break JSX
    jsx = jsx.replace(/&nbsp;/g, ' ')
             .replace(/&quot;/g, '"');
    
    // 4) Convert class= to className=
    jsx = jsx.replace(/\bclass=/g, 'className=');
    
    // 5) Convert for= to htmlFor= (but not inside URLs)
    jsx = jsx.replace(/\bfor="/g, 'htmlFor="');
    
    // 6) Convert other HTML attributes to React equivalents
    for (const [html, react] of Object.entries(ATTR_MAP)) {
        if (html === 'class' || html === 'for') continue;

        // attr="value" → reactAttr="value"
        const eqRegex = new RegExp(`\\b${html}=`, 'gi');
        jsx = jsx.replace(eqRegex, `${react}=`);

        // standalone boolean attr (no =) → reactAttr
        const boolRegex = new RegExp(`\\b${html}(?=[\\s>\\/])`, 'gi');
        jsx = jsx.replace(boolRegex, react);
    }
    
    // 7) Convert SVG/HTML hyphenated attributes to camelCase
    //    (stroke-width, fill-rule, clip-path, stop-color, etc.)
    //    Must do AFTER the ATTR_MAP pass to avoid double-processing.
    const SVG_ATTR_MAP = {
        'stroke-width':       'strokeWidth',
        'stroke-linecap':     'strokeLinecap',
        'stroke-linejoin':    'strokeLinejoin',
        'stroke-dasharray':   'strokeDasharray',
        'stroke-dashoffset':  'strokeDashoffset',
        'stroke-miterlimit':  'strokeMiterlimit',
        'stroke-opacity':     'strokeOpacity',
        'fill-rule':          'fillRule',
        'fill-opacity':       'fillOpacity',
        'clip-path':          'clipPath',
        'clip-rule':          'clipRule',
        'stop-color':         'stopColor',
        'stop-opacity':       'stopOpacity',
        'flood-color':        'floodColor',
        'flood-opacity':      'floodOpacity',
        'lighting-color':     'lightingColor',
        'color-interpolation': 'colorInterpolation',
        'color-rendering':    'colorRendering',
        'shape-rendering':    'shapeRendering',
        'text-rendering':     'textRendering',
        'image-rendering':    'imageRendering',
        'dominant-baseline':  'dominantBaseline',
        'alignment-baseline': 'alignmentBaseline',
        'baseline-shift':     'baselineShift',
        'mask-type':          'maskType',
        'marker-start':       'markerStart',
        'marker-mid':         'markerMid',
        'marker-end':         'markerEnd',
        'paint-order':        'paintOrder',
        'vector-effect':      'vectorEffect',
        'writing-mode':       'writingMode',
        'glyph-orientation-horizontal': 'glyphOrientationHorizontal',
        'glyph-orientation-vertical':   'glyphOrientationVertical',
        'font-size':          'fontSize',
        'font-family':        'fontFamily',
        'font-weight':        'fontWeight',
        'font-style':         'fontStyle',
        'font-variant':       'fontVariant',
        'font-stretch':       'fontStretch',
        'letter-spacing':     'letterSpacing',
        'word-spacing':       'wordSpacing',
        'text-anchor':        'textAnchor',
        'text-decoration':    'textDecoration',
        'pointer-events':     'pointerEvents',
    };
    for (const [svg, react] of Object.entries(SVG_ATTR_MAP)) {
        // Only replace when used as an HTML attribute (preceded by whitespace or start of tag)
        const regex = new RegExp(`\\b${svg}=`, 'g');
        jsx = jsx.replace(regex, `${react}=`);
    }
    
    // 7b) Remove quotes from CSS font-family values.
    //     Framer/Webflow output: font-family: "Inter", "Inter Placeholder", sans-serif
    //     The internal " terminates the style="..." attribute match early, leaking the
    //     rest of the font list as raw JSX text. Quotes around font names are optional in CSS.
    jsx = jsx.replace(/\bfont-family\s*:\s*((?:[^;{}<>])*)/g, (match, fonts) => {
        return 'font-family: ' + fonts.replace(/['"]/g, '').trim();
    });

    // 8) Convert inline style="" to style={{}}
    jsx = jsx.replace(/\bstyle="([^"]*?)"/g, (match, styleStr) => {
        const converted = convertStyleString(styleStr);
        if (!converted) return 'style={{}}';
        return `style=${converted}`;
    });
    jsx = jsx.replace(/\bstyle='([^']*?)'/g, (match, styleStr) => {
        const converted = convertStyleString(styleStr);
        if (!converted) return 'style={{}}';
        return `style=${converted}`;
    });
    
    // 9) Convert boolean attributes (React prefers camelCase and standard boolean logic)
    const BOOLEANS = [
        'disabled', 'checked', 'selected', 'required', 'multiple', 
        'hidden', 'noValidate', 'defer', 'async', 'autoPlay', 
        'loop', 'muted', 'playsInline', 'noValidate'
    ];
    for (const boolAttr of BOOLEANS) {
        const regex = new RegExp(`\\b${boolAttr}=""`, 'gi');
        jsx = jsx.replace(regex, boolAttr);
    }
    
    // 10) Remove on* event handlers (onclick, onmouseover, etc.)
    jsx = jsx.replace(/\bon[a-z]+="[^"]*"/gi, '');
    jsx = jsx.replace(/\bon[a-z]+='[^']*'/gi, '');
    
    // 11) Remove inline scripts
    jsx = jsx.replace(/<script(?![^>]*\bsrc\b)[^>]*>[\s\S]*?<\/script>/gi, '');

    // 12) Remove <noscript> blocks entirely — they contain raw CSS with { } that break JSX
    jsx = jsx.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');

    // 13) Remove <style> blocks entirely — CSS is loaded via layout imports, not inline
    //     Raw CSS braces { } inside JSX cause "Expected '}', got ':'" parse errors
    jsx = jsx.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // 14) Convert value= on form inputs to defaultValue= 
    //     React warns when value= is used without onChange (controlled component pattern).
    //     Since converted sites have no React state, defaultValue= is always correct.
    jsx = jsx.replace(/<(input|textarea|select)(\s[^>]*?)?\bvalue=/gi, (_, tag, attrs) => {
        return `<${tag}${attrs || ''} defaultValue=`;
    });
    
    return jsx;
}


// ── Extract metadata from <head> ────────────────────────────
function extractMetadata($) {
    const metadata = {
        title: $('title').text() || 'My Website',
        description: $('meta[name="description"]').attr('content') || '',
        ogImage: $('meta[property="og:image"]').attr('content') || '',
        favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || '/favicon.ico',
        themeColor: $('meta[name="theme-color"]').attr('content') || '',
        viewport: $('meta[name="viewport"]').attr('content') || 'width=device-width, initial-scale=1',
    };
    return metadata;
}

// ── Extract CSS links from <head> ───────────────────────────
function extractCSSImports($) {
    const cssFiles = [];
    $('link[rel="stylesheet"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) cssFiles.push(href);
    });
    return cssFiles;
}

// ── Build a Next.js page component from HTML ────────────────
// Returns { code: string, inlineCss: string }
function buildPageComponent(bodyHtml, pageName, isHomepage, platform = 'webflow') {
    // Extract <style> blocks BEFORE htmlToJsx strips them.
    // Raw CSS braces { } break JSX parsing, so we save the CSS content
    // separately as a real .css file (imported by layout) and remove the
    // tag from the HTML so htmlToJsx never sees the braces.
    const inlineCssParts = [];
    bodyHtml = bodyHtml.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
        if (css.trim()) inlineCssParts.push(css.trim());
        return '';
    });
    const inlineCss = inlineCssParts.join('\n\n');

    const jsxContent = htmlToJsx(bodyHtml);
    
    let componentName = pageName
        .replace(/[^a-zA-Z0-9]/g, '')
        .replace(/^./, c => c.toUpperCase()) || 'Page';
        
    if (/^\d/.test(componentName)) {
        componentName = 'Num' + componentName;
    }
    
    // Escaping backticks and interpolation in jsxContent so they don't break this template literal
    const escapedJsx = jsxContent.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

    const isFramer = platform === 'framer';
    const code = `'use client';
${isFramer ? "import { motion } from 'framer-motion';" : "import { useState, useEffect } from 'react';"}

export default function ${isHomepage ? 'Home' : componentName}Page() {
${isFramer ? '' : `  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return null;
`}
  return (
    <div${isFramer ? '' : ' suppressHydrationWarning'}>
      ${escapedJsx}
    </div>
  );
}
`;
    return { code, inlineCss };
}


// ── Build WebflowInitializer.js component ───────────────────
function buildWebflowInitializer() {
    return `'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

export default function WebflowInitializer() {
  const pathname = usePathname();

  useEffect(() => {
    const initWebflow = () => {
      if (typeof window === 'undefined') return;

      // Remove Webflow "remove-flicker" locks that hide hero elements
      document.querySelectorAll('[remove-flicker]').forEach((el) => {
        el.style.opacity = '';
        el.style.visibility = '';
        el.removeAttribute('remove-flicker');
      });

      if (window.Webflow && window.Webflow.require) {
        try {
          const ix2 = window.Webflow.require('ix2');
          if (ix2) {
            if (typeof ix2.destroy === 'function') ix2.destroy();
            ix2.init();
          }
          window.Webflow.ready();
          if (window.ScrollTrigger) window.ScrollTrigger.refresh(true);
          window.dispatchEvent(new Event('resize'));
        } catch (err) {
          console.warn('Webflow/GSAP re-init:', err.message);
        }
      }
    };

    const timer = setTimeout(initWebflow, 300);
    return () => clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    return () => {
      // Kill all ScrollTrigger instances on unmount to prevent ghost animations
      if (window.ScrollTrigger && typeof window.ScrollTrigger.getAll === 'function') {
        window.ScrollTrigger.getAll().forEach(function(t) { t.kill(); });
      }
    };
  }, []);

  return null;
}
`;
}

// ── Build root layout.js ────────────────────────────────────
function buildRootLayout(metadata, cssImports, fontLinks, jsFiles) {
    const cssImportStatements = cssImports
        .map((f, i) => `import '@/styles/${f}';`)
        .join('\n');
    
    // Extract Google Fonts URLs
    const googleFontLinks = fontLinks
        .filter(l => l.includes('fonts.googleapis.com') || l.includes('fonts.gstatic.com'))
        .map(l => `        <link rel="preconnect" href="${l.includes('gstatic') ? 'https://fonts.gstatic.com' : 'https://fonts.googleapis.com'}" crossOrigin="anonymous" />`)
        .join('\n');
    
    const googleFontStylesheets = fontLinks
        .filter(l => l.includes('fonts.googleapis.com/css'))
        .map(l => `        <link rel="stylesheet" href="${l}" />`)
        .join('\n');

    // Classify local JS files by loading priority
    const jQueryFile = jsFiles.find(f => f.includes('jquery'));
    const gsapCore = jsFiles.find(f => f === 'gsap.min.js');
    const scrollTrigger = jsFiles.find(f => f.includes('ScrollTrigger'));
    const splitText = jsFiles.find(f => f.includes('SplitText'));
    const lenisFile = jsFiles.find(f => f.includes('lenis'));
    // Main webflow runtime (not schunks)
    const wfMain = jsFiles.find(f => /^webflow\.[a-f0-9]+\.[a-f0-9]+\.js$/.test(f));
    // Webflow schunks (interaction chunks)
    const wfSchunks = jsFiles.filter(f => f.includes('schunk'));
    // Any other webflow bundles
    const wfOther = jsFiles.filter(f => 
        f.includes('webflow') && !f.includes('schunk') && f !== wfMain &&
        !f.includes('jquery') && !f.includes('gsap') && !f.includes('ScrollTrigger') &&
        !f.includes('SplitText') && !f.includes('lenis')
    );

    // Build Script tags
    const scriptLines = [];
    if (jQueryFile)     scriptLines.push(`        <Script src="/js/${jQueryFile}" strategy="beforeInteractive" />`);
    if (gsapCore)       scriptLines.push(`        <Script src="/js/${gsapCore}" strategy="beforeInteractive" />`);
    if (scrollTrigger)  scriptLines.push(`        <Script src="/js/${scrollTrigger}" strategy="beforeInteractive" />`);
    if (splitText)      scriptLines.push(`        <Script src="/js/${splitText}" strategy="lazyOnload" />`);
    if (lenisFile)      scriptLines.push(`        <Script src="/js/${lenisFile}" strategy="afterInteractive" />`);
    if (wfMain)         scriptLines.push(`        <Script src="/js/${wfMain}" strategy="afterInteractive" />`);
    wfSchunks.forEach(f => scriptLines.push(`        <Script src="/js/${f}" strategy="lazyOnload" />`));
    wfOther.forEach(f =>   scriptLines.push(`        <Script src="/js/${f}" strategy="lazyOnload" />`));

    const scriptBlock = scriptLines.join('\n');

    return `import './globals.css';
${cssImportStatements}
import Script from 'next/script';
import WebflowInitializer from './WebflowInitializer';

export const metadata = {
  title: '${metadata.title.replace(/'/g, "\\'")}',
  description: '${metadata.description.replace(/'/g, "\\'")}',
  icons: {
    icon: '${metadata.favicon}',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
${googleFontLinks}
${googleFontStylesheets}
      </head>
      <body suppressHydrationWarning>
${scriptBlock}

        <WebflowInitializer />
        {children}
      </body>
    </html>
  );
}
`;
}

// ── Build globals.css ───────────────────────────────────────
function buildGlobalsCss() {
    return `/* Global Reset & Base Styles */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  scroll-behavior: smooth;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  min-height: 100vh;
}

img, video {
  max-width: 100%;
  height: auto;
  display: block;
}

a {
  text-decoration: inherit;
  color: inherit;
}
`;
}

// ── Build package.json ──────────────────────────────────────
function buildPackageJson(siteName, extraDeps = {}) {
    return JSON.stringify({
        name: siteName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'),
        version: '1.0.0',
        private: true,
        scripts: {
            dev: 'next dev',
            build: 'next build',
            start: 'next start',
            lint: 'next lint',
        },
        dependencies: {
            next: '^14.2.0',
            react: '^18.3.0',
            'react-dom': '^18.3.0',
            ...extraDeps,
        },
        devDependencies: {
            eslint: '^8.0.0',
            'eslint-config-next': '^14.2.0',
            tailwindcss: '^3.4.0',
            '@types/node': '^20.0.0',
            '@types/react': '^18.3.0',
            '@types/react-dom': '^18.3.0',
            typescript: '^5.0.0',
        },
    }, null, 2);
}

// ── Build next.config.js ────────────────────────────────────
function buildNextConfig(assetDomains, exportMode) {
    const domains = [...new Set(assetDomains)].filter(Boolean);
    const isStatic = exportMode === 'static';

    return `/** @type {import('next').NextConfig} */
const nextConfig = {
${isStatic ? `  output: 'export',\n  trailingSlash: true,` : ''}
  images: {
    unoptimized: ${isStatic},
    ${!isStatic ? `formats: ['image/avif', 'image/webp'],` : ''}
    ${domains.length > 0 ? `remotePatterns: [
${domains.map(d => `      { protocol: 'https', hostname: '${d}' },`).join('\n')}
    ],` : ''}
  },
};

module.exports = nextConfig;
`;
}

// ── Build vercel.json ───────────────────────────────────────
function buildVercelJson() {
    return JSON.stringify({
        $schema: 'https://openapi.vercel.sh/vercel.json',
        framework: 'nextjs',
        buildCommand: 'next build',
        outputDirectory: 'out',
    }, null, 2);
}

// ── Build .gitignore ────────────────────────────────────────
function buildGitignore() {
    return `# Dependencies
/node_modules
/.pnp
.pnp.js

# Next.js
/.next/
/out/

# Production
/build

# Misc
.DS_Store
*.pem
.env*.local

# Debug
npm-debug.log*

# Vercel
.vercel

# IDE
.vscode/
.idea/
`;
}

// ── Build README ────────────────────────────────────────────
function buildReadme(siteName, pageCount) {
    return `# ${siteName}

Fully functional Next.js website generated by **FreeHTML.pro**.

## 🚀 Quick Start

\`\`\`bash
# Install dependencies
npm install

# Start development server
npm run dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000) in your browser.

## 📦 Deploy to Vercel

1. Push this folder to a GitHub repository
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your repository
4. Click **Deploy** — that's it!

Or use the Vercel CLI:
\`\`\`bash
npx vercel
\`\`\`

## 📁 Project Structure

\`\`\`
├── app/              # Next.js App Router pages
│   ├── layout.js     # Root layout (fonts, global CSS)
│   ├── page.js       # Homepage
│   └── .../page.js   # Sub-pages
├── public/           # Static assets (images, fonts, media)
├── styles/           # CSS stylesheets
├── next.config.js    # Next.js configuration
├── vercel.json       # Vercel deployment config
└── package.json      # Dependencies
\`\`\`

## 📊 Stats
- **${pageCount}** pages converted
- Built with **Next.js 14** (App Router)
- Static export ready — host anywhere!

---
*Generated by [FreeHTML.pro](https://freehtml.pro) — The #1 Website Exporter*
`;
}

// ── Determine route path from URL ───────────────────────────
function getRoutePath(pageUrl, baseUrl) {
    try {
        const url = new URL(pageUrl);
        let pathname = url.pathname;
        
        // Clean up
        if (pathname === '/' || pathname === '') return '/';
        if (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
        if (pathname.startsWith('/')) pathname = pathname.slice(1);
        
        // Remove .html extension
        pathname = pathname.replace(/\.html$/, '');
        
        return '/' + pathname;
    } catch {
        return '/';
    }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN CONVERTER: Takes crawled pages + assets → Next.js project
// ═══════════════════════════════════════════════════════════════
function convertToNextJS(pages, collector, hostname, options = {}) {
    const { exportMode = 'ssr', language = 'ts', platform = 'webflow' } = options;
    const files = []; // { path: string, content: string|Buffer }
    
    // ── Collect metadata from homepage ──
    const homepage = pages.find(p => {
        try { return new URL(p.url).pathname === '/' || new URL(p.url).pathname === ''; } 
        catch { return false; }
    }) || pages[0];
    
    const $home = homepage.$;
    const metadata = extractMetadata($home);
    
    // ── Collect all CSS files for layout imports ──
    const allCssFiles = [];
    const fontLinks = [];
    const assetDomains = [];
    
    // Get CSS from collector
    const cssAssets = collector.getAllByType('css');
    cssAssets.forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            const filename = path.basename(asset.localPath);
            allCssFiles.push(filename);
        }
    });
    
    // Get Google Fonts links from homepage
    $home('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"]').each((i, el) => {
        fontLinks.push($home(el).attr('href'));
    });
    
    // Track asset domains for next.config.js
    collector.getAll().forEach(a => {
        try { assetDomains.push(new URL(a.url).hostname); } catch {}
    });
    
    // ── Generate page components ──
    pages.forEach((page) => {
        const routePath = getRoutePath(page.url, `https://${hostname}`);
        const isHomepage = routePath === '/';
        
        // Get body content
        const $ = page.$;
        
        // Remove <script> tags that are inline (keep src ones but they'll be in public/)
        $('script:not([src])').remove();
        // Remove <link rel="stylesheet"> (handled in layout)
        $('link[rel="stylesheet"]').remove();
        
        // Fix React Hydration mismatches by changing inline tags that wrap block tags into divs
        $('p, span').each((i, el) => {
            if ($(el).find('div, ul, ol, h1, h2, h3, h4, h5, h6, form, nav, section, article, aside, footer, header, table').length > 0) {
                el.tagName = 'div';
            }
        });
        
        // Remove <style> tags from body (we'll keep them but convert)
        
        const bodyHtml = $('body').html() || $.html();
        
        // Build component name from route
        const segments = routePath.split('/').filter(Boolean);
        const pageName = segments.length > 0 
            ? segments.map(s => s.replace(/[^a-zA-Z0-9]/g, '').replace(/^./, c => c.toUpperCase())).join('')
            : 'Home';
        
        const { code: componentCode, inlineCss } = buildPageComponent(bodyHtml, pageName, isHomepage, platform);

        // Determine file path
        const ext = language === 'ts' ? 'tsx' : 'js';
        let filePath;
        if (isHomepage) {
            filePath = `app/page.${ext}`;
        } else {
            filePath = `app${routePath}/page.${ext}`;
        }

        files.push({ path: filePath, content: componentCode });

        // Write extracted inline <style> content as a real CSS file so keyframes
        // and media queries are preserved (they can't live inside JSX).
        if (inlineCss) {
            const cssSlug = isHomepage ? 'home' : pageName.toLowerCase().replace(/[^a-z0-9]/g, '-');
            const inlineCssFile = `inline-${cssSlug}.css`;
            files.push({ path: `styles/${inlineCssFile}`, content: inlineCss });
            allCssFiles.push(inlineCssFile);
        }
    });
    
    // ── WebflowInitializer component ──
    files.push({
        path: language === 'ts' ? 'app/WebflowInitializer.tsx' : 'app/WebflowInitializer.js',
        content: buildWebflowInitializer(),
    });

    // ── Collect JS filenames for layout script tags ──
    const jsFileNames = collector.getAllByType('js')
        .filter(a => a.downloaded && a.buffer)
        .map(a => path.basename(a.localPath));

    // ── Layout ──
    files.push({
        path: 'app/layout.js',
        content: buildRootLayout(metadata, allCssFiles, fontLinks, jsFileNames),
    });
    
    // ── globals.css ──
    files.push({
        path: 'app/globals.css',
        content: buildGlobalsCss(),
    });
    
    // ── CSS files in styles/ ──
    cssAssets.forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            const filename = path.basename(asset.localPath);
            // Rewrite url() in CSS to point to /public/ 
            let cssContent = asset.buffer.toString('utf-8');
            cssContent = cssContent.replace(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi, (match, rawUrl) => {
                if (rawUrl.startsWith('data:') || rawUrl.startsWith('#') || rawUrl.startsWith('blob:')) return match;
                // Convert to absolute /images/ or /fonts/ path
                const type = classifyUrl(rawUrl);
                if (type === 'fonts') {
                    const fname = path.basename(rawUrl).split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
                    return `url('/fonts/${fname}')`;
                } else {
                    const fname = path.basename(rawUrl).split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
                    return `url('/images/${fname}')`;
                }
            });
            files.push({ path: `styles/${filename}`, content: cssContent });
        }
    });
    
    // ── tsconfig / jsconfig ──
    if (language === 'ts') {
        files.push({
            path: 'tsconfig.json',
            content: JSON.stringify({
                compilerOptions: {
                    target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'],
                    allowJs: true, skipLibCheck: true, strict: true,
                    noEmit: true, esModuleInterop: true, moduleResolution: 'bundler',
                    resolveJsonModule: true, isolatedModules: true, jsx: 'preserve',
                    incremental: true, paths: { '@/*': ['./*'] },
                },
                include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
                exclude: ['node_modules'],
            }, null, 2),
        });
    } else {
        files.push({
            path: 'jsconfig.json',
            content: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }, null, 2),
        });
    }
    
    // ── Config files ──
    const extraDeps = platform === 'framer' ? { 'framer-motion': '^11.0.0' } : {};
    files.push({ path: 'package.json', content: buildPackageJson(hostname, extraDeps) });
    files.push({ path: 'next.config.js', content: buildNextConfig([...new Set(assetDomains)].slice(0, 10), exportMode) });
    files.push({ path: 'vercel.json', content: buildVercelJson() });
    files.push({ path: '.gitignore', content: buildGitignore() });
    files.push({ path: 'README.md', content: buildReadme(hostname, pages.length) });
    
    // ── Public assets ──
    // Images
    collector.getAllByType('images').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            const filename = path.basename(asset.localPath);
            files.push({ path: `public/images/${filename}`, content: asset.buffer, isBinary: true });
        }
    });
    
    // Fonts
    collector.getAllByType('fonts').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            const filename = path.basename(asset.localPath);
            files.push({ path: `public/fonts/${filename}`, content: asset.buffer, isBinary: true });
        }
    });
    
    // Media
    collector.getAllByType('media').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            const filename = path.basename(asset.localPath);
            files.push({ path: `public/media/${filename}`, content: asset.buffer, isBinary: true });
        }
    });
    
    // JS files → public/js/
    collector.getAllByType('js').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            const filename = path.basename(asset.localPath);
            files.push({ path: `public/js/${filename}`, content: asset.buffer, isBinary: true });
        }
    });
    
    return files;
}

// Helper to classify URL by file type
function classifyUrl(url) {
    const lower = url.toLowerCase();
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(lower)) return 'fonts';
    if (/\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)(\?|$)/i.test(lower)) return 'images';
    if (/\.(mp4|webm|ogg|mov|mp3|wav)(\?|$)/i.test(lower)) return 'media';
    if (/\.(js|mjs)(\?|$)/i.test(lower)) return 'js';
    if (/\.(css)(\?|$)/i.test(lower)) return 'css';
    return 'images';
}

module.exports = { convertToNextJS, htmlToJsx };

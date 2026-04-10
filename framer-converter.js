// ═══════════════════════════════════════════════════════════════
//  FRAMER CONVERTER
//  Converts Framer-exported HTML pages into Next.js TSX files
//  with Framer Motion animations wired correctly.
// ═══════════════════════════════════════════════════════════════

const cheerio = require('cheerio');
const path = require('path');
const { htmlToJsx } = require('./nextjs-converter.js');

// Map of Framer appear directions to Framer Motion initial states
const APPEAR_DIRECTION_MAP = {
    'bottom': { y: 30 },
    'top': { y: -30 },
    'left': { x: -30 },
    'right': { x: 30 },
    'zoom': { scale: 0.9 },
};

/**
 * Strip Framer runtime scripts and hydration attributes.
 * @param {object} $ - Cheerio root
 */
function stripFramerRuntime($) {
    $('script[src*="framer.com"], script[src*="framerusercontent.com"]').remove();
    $('[data-framer-hydrate-v2]').removeAttr('data-framer-hydrate-v2');
    $('[data-framer-name]').removeAttr('data-framer-name');
    $('[data-framer-component-type]').removeAttr('data-framer-component-type');
    $('meta[name="generator"][content*="Framer"]').remove();
}

/**
 * Mark elements with Framer appear attributes with motion data markers.
 * @param {object} $ - Cheerio root
 */
function wrapAnimatedElements($) {
    $('[data-framer-appear-id]').each((_, el) => {
        const $el = $(el);
        const classStr = $el.attr('class') || '';

        let direction = 'bottom';
        if (classStr.includes('framer-v-top')) direction = 'top';
        else if (classStr.includes('framer-v-left')) direction = 'left';
        else if (classStr.includes('framer-v-right')) direction = 'right';
        else if (classStr.includes('framer-v-zoom')) direction = 'zoom';

        const initial = APPEAR_DIRECTION_MAP[direction] || { y: 30 };
        const initialJson = JSON.stringify({ opacity: 0, ...initial });
        const animateJson = JSON.stringify({ opacity: 1, y: 0, x: 0, scale: 1 });

        $el.attr('data-motion-initial', initialJson);
        $el.attr('data-motion-animate', animateJson);
        $el.removeAttr('data-framer-appear-id');
    });
}

/**
 * Post-process JSX string: convert data-motion-* markers to Framer Motion props.
 * @param {string} jsx
 * @returns {string}
 */
function convertMotionMarkers(jsx) {
    return jsx.replace(
        /data-motion-initial="([^"]+)"\s+data-motion-animate="([^"]+)"/g,
        (_, initial, animate) => {
            const cleanInitial = initial.replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
            const cleanAnimate = animate.replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
            return `initial={${cleanInitial}} whileInView={${cleanAnimate}} viewport={{ once: true }} transition={{ duration: 0.5, ease: 'easeOut' }}`;
        }
    );
}

/**
 * Build a Framer page component TSX with Framer Motion animations.
 * @param {string} bodyHtml
 * @param {string} componentName
 * @param {boolean} isHomepage
 * @returns {string}
 */
function buildFramerPageComponent(bodyHtml, componentName, isHomepage) {
    const $ = cheerio.load(bodyHtml);

    stripFramerRuntime($);
    wrapAnimatedElements($);

    const processedHtml = $('body').html() || '';
    let jsx = htmlToJsx(processedHtml);
    jsx = convertMotionMarkers(jsx);

    const escapedJsx = jsx.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    const name = isHomepage ? 'Home' : (componentName || 'Page');

    return `'use client';
import { motion } from 'framer-motion';

export default function ${name}Page() {
  return (
    <div>
      ${escapedJsx}
    </div>
  );
}
`;
}

/**
 * Build root layout for Framer sites — no Webflow scripts, clean HTML.
 */
function buildFramerLayout(metadata, cssImports) {
    const cssStatements = cssImports.map(f => `import '../styles/${f}';`).join('\n');

    return `import './globals.css';
${cssStatements}

export const metadata = {
  title: '${metadata.title.replace(/'/g, "\\'")}',
  description: '${metadata.description.replace(/'/g, "\\'")}',
  icons: { icon: '${metadata.favicon}' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
}

/**
 * Build Framer layout for JavaScript mode.
 */
function buildFramerLayoutJs(metadata, cssImports) {
    const cssStatements = cssImports.map(f => `import '../styles/${f}';`).join('\n');

    return `import './globals.css';
${cssStatements}

export const metadata = {
  title: '${metadata.title.replace(/'/g, "\\'")}',
  description: '${metadata.description.replace(/'/g, "\\'")}',
  icons: { icon: '${metadata.favicon}' },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
}

/**
 * Convert Framer-crawled pages to Next.js project files.
 * @param {{ url: string, checkUrl: string, $: object }[]} pages
 * @param {object} collector - AssetCollector instance
 * @param {string} hostname
 * @param {{ exportMode: string, language: string }} options
 * @returns {{ path: string, content: string|Buffer, isBinary: boolean }[]}
 */
function convertFramerToNextJS(pages, collector, hostname, options = {}) {
    const { exportMode = 'ssr', language = 'ts' } = options;
    const isStatic = exportMode === 'static';
    const ext = language === 'ts' ? 'tsx' : 'jsx';
    const files = [];

    // ── Collect homepage metadata ──
    const homepage = pages.find(p => {
        try { return new URL(p.url).pathname === '/' || new URL(p.url).pathname === ''; }
        catch { return false; }
    }) || pages[0];

    const $home = homepage.$;
    const metadata = {
        title: $home('title').text() || 'My Website',
        description: $home('meta[name="description"]').attr('content') || '',
        favicon: $home('link[rel="icon"]').attr('href') || '/favicon.ico',
    };

    // ── Collect CSS file names from collector ──
    const cssFiles = collector.getAllByType('css')
        .filter(a => a.downloaded && a.buffer)
        .map(a => path.basename(a.localPath));

    // ── Build layout ──
    const layoutContent = language === 'ts'
        ? buildFramerLayout(metadata, cssFiles)
        : buildFramerLayoutJs(metadata, cssFiles);
    files.push({ path: `app/layout.${ext}`, content: layoutContent, isBinary: false });

    // ── Build pages ──
    for (const page of pages) {
        let pathname = '/';
        try { pathname = new URL(page.url).pathname || '/'; } catch {}

        const isHomepage = pathname === '/' || pathname === '';
        const bodyHtml = page.$('body').html() || '';

        const segments = pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
        let pageName = segments.length > 0
            ? segments.map(s => s.replace(/[^a-zA-Z0-9]/g, '').replace(/^./, c => c.toUpperCase())).join('')
            : 'Home';
        if (/^\d/.test(pageName)) pageName = 'Num' + pageName;

        const pageCode = buildFramerPageComponent(bodyHtml, pageName, isHomepage);

        if (isHomepage) {
            files.push({ path: `app/page.${ext}`, content: pageCode, isBinary: false });
        } else {
            const routePath = pathname.replace(/^\//, '').replace(/\/$/, '');
            files.push({ path: `app/${routePath}/page.${ext}`, content: pageCode, isBinary: false });
        }
    }

    // ── globals.css ──
    files.push({
        path: 'app/globals.css',
        content: `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; -webkit-font-smoothing: antialiased; }
body { min-height: 100vh; }
img, video { max-width: 100%; height: auto; display: block; }
a { text-decoration: inherit; color: inherit; }
`,
        isBinary: false,
    });

    // ── CSS files ──
    collector.getAllByType('css').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            files.push({ path: `styles/${path.basename(asset.localPath)}`, content: asset.buffer, isBinary: true });
        }
    });

    // ── Public assets ──
    collector.getAllByType('images').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            files.push({ path: `public/images/${path.basename(asset.localPath)}`, content: asset.buffer, isBinary: true });
        }
    });
    collector.getAllByType('fonts').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            files.push({ path: `public/fonts/${path.basename(asset.localPath)}`, content: asset.buffer, isBinary: true });
        }
    });
    collector.getAllByType('media').forEach(asset => {
        if (asset.downloaded && asset.buffer) {
            files.push({ path: `public/media/${path.basename(asset.localPath)}`, content: asset.buffer, isBinary: true });
        }
    });

    // ── next.config.js ──
    files.push({
        path: 'next.config.js',
        content: `/** @type {import('next').NextConfig} */
const nextConfig = {
${isStatic ? `  output: 'export',\n  trailingSlash: true,` : ''}
  images: { unoptimized: ${isStatic} },
};
module.exports = nextConfig;
`,
        isBinary: false,
    });

    // ── package.json ──
    files.push({
        path: 'package.json',
        content: JSON.stringify({
            name: hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'),
            version: '1.0.0',
            private: true,
            scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
            dependencies: {
                next: '^14.2.0',
                react: '^18.3.0',
                'react-dom': '^18.3.0',
                'framer-motion': '^11.0.0',
            },
            devDependencies: {
                eslint: '^8.0.0',
                'eslint-config-next': '^14.2.0',
                tailwindcss: '^3.4.0',
                typescript: '^5.0.0',
                '@types/node': '^20.0.0',
                '@types/react': '^18.3.0',
                '@types/react-dom': '^18.3.0',
            },
        }, null, 2),
        isBinary: false,
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
            isBinary: false,
        });
    } else {
        files.push({
            path: 'jsconfig.json',
            content: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }, null, 2),
            isBinary: false,
        });
    }

    // ── vercel.json + .gitignore ──
    files.push({
        path: 'vercel.json',
        content: JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', framework: 'nextjs' }, null, 2),
        isBinary: false,
    });
    files.push({
        path: '.gitignore',
        content: 'node_modules/\n.next/\nout/\n.env*.local\n.DS_Store\n',
        isBinary: false,
    });

    return files;
}

module.exports = { convertFramerToNextJS };

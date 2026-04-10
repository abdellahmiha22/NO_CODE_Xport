// ═══════════════════════════════════════════════════════════════
//  TOKEN EXTRACTOR
//  Parses CSS custom properties → Tailwind config theme tokens
// ═══════════════════════════════════════════════════════════════

/**
 * Extract design tokens from an array of CSS file contents.
 * @param {string[]} cssFiles
 * @returns {{ colors: Record<string,string>, fonts: Record<string,string>, spacing: Record<string,string>, radii: Record<string,string> }}
 */
function extractTokens(cssFiles) {
    const tokens = { colors: {}, fonts: {}, spacing: {}, radii: {} };

    for (const css of cssFiles) {
        const rootBlocks = css.match(/:root\s*\{([^}]+)\}/g) || [];
        for (const block of rootBlocks) {
            const props = block.match(/--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g) || [];
            for (const prop of props) {
                const match = prop.match(/--([a-zA-Z0-9-]+)\s*:\s*(.+?)\s*;/);
                if (!match) continue;
                const [, name, value] = match;
                const cleanValue = value.trim().replace(/^["']|["']$/g, '');

                if (name.startsWith('color-')) {
                    tokens.colors[name.replace('color-', '')] = cleanValue;
                } else if (name.startsWith('font-')) {
                    tokens.fonts[name.replace('font-', '')] = cleanValue;
                } else if (name.startsWith('spacing-')) {
                    tokens.spacing[name.replace('spacing-', '')] = cleanValue;
                } else if (name.startsWith('radius-')) {
                    tokens.radii[name.replace('radius-', '')] = cleanValue;
                }
            }
        }
    }
    return tokens;
}

/**
 * Generate tailwind.config.ts content from extracted tokens.
 * @param {{ colors: Record<string,string>, fonts: Record<string,string>, spacing: Record<string,string>, radii: Record<string,string> }} tokens
 * @returns {string}
 */
function buildTailwindConfig(tokens) {
    const colorsEntries = Object.entries(tokens.colors)
        .map(([k, v]) => `      '${k}': '${v}',`)
        .join('\n');

    const fontsEntries = Object.entries(tokens.fonts)
        .map(([k, v]) => {
            const fontName = v.replace(/['"]/g, '').split(',')[0].trim();
            return `      '${k}': ['${fontName}', 'sans-serif'],`;
        })
        .join('\n');

    const spacingEntries = Object.entries(tokens.spacing)
        .map(([k, v]) => `      '${k}': '${v}',`)
        .join('\n');

    const radiiEntries = Object.entries(tokens.radii)
        .map(([k, v]) => `      '${k}': '${v}',`)
        .join('\n');

    const sections = [];
    if (colorsEntries) sections.push(`      colors: {\n${colorsEntries}\n      },`);
    if (fontsEntries) sections.push(`      fontFamily: {\n${fontsEntries}\n      },`);
    if (spacingEntries) sections.push(`      spacing: {\n${spacingEntries}\n      },`);
    if (radiiEntries) sections.push(`      borderRadius: {\n${radiiEntries}\n      },`);

    return `import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx,js,jsx}',
    './components/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
${sections.join('\n')}
    },
  },
  plugins: [],
};

export default config;
`;
}

module.exports = { extractTokens, buildTailwindConfig };

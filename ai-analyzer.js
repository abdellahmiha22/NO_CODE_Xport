require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

// Clean up HTML to reduce token usage and improve AI focus
function cleanHtmlForAI(html) {
    if (!html) return '';
    // Basic cleanup: remove massive base64 strings and inline SVGs to save tokens
    let cleaned = html.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/g, 'data:image/...');
    cleaned = cleaned.replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, '<svg>...</svg>');
    return cleaned;
}

async function analyzeWebsite(html, cssTokens, targetUrl) {
    // If no API key is provided, we gracefully skip AI analysis
    if (!process.env.GEMINI_API_KEY) {
        console.warn('⚠️ GEMINI_API_KEY not found in .env. Skipping AI analysis.');
        return { error: 'GEMINI_API_KEY not found in environment variables.' };
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const cleanedHtml = cleanHtmlForAI(html);

    const basePromptContext = `
You are an expert Marketing Systems Operator and UI/UX engineer. 
Analyze the following website (URL: ${targetUrl}).
    `;

    try {
        console.log(`  🧠 Starting AI Analysis for ${targetUrl}...`);

        // 1. Generate Design System (W3C DTCG Format)
        const designSystemPrompt = `
${basePromptContext}
Based on the provided HTML structure and these extracted CSS tokens:
${JSON.stringify(cssTokens).substring(0, 5000)} // Truncated to avoid overflow

Extract the complete design system and output it EXACTLY matching the W3C Design Tokens Community Group JSON format.
It must include:
- Colors (primary, secondary, background, text)
- Typography (font families, scales)
- Spacing (if detectable)

Respond ONLY with valid JSON. Do not include markdown formatting like \`\`\`json.
        `;

        // 2. Generate Funnel Map
        const funnelPrompt = `
${basePromptContext}
Based on the provided HTML, analyze the user journey and funnel.
Output a Markdown document detailing:
1. Primary Call to Actions (CTAs)
2. Entry Points (Forms, Chatbots, WhatsApp buttons)
3. The perceived user journey (e.g., Landing -> Click CTA -> Form -> Booking)
4. Navigation structure
        `;

        // 3. Generate Frontend Psychology Report
        const psychPrompt = `
${basePromptContext}
Based on the provided HTML, analyze the frontend psychology and conversion elements.
Output a Markdown document detailing:
1. The Core Offer / Value Proposition
2. Trust Signals (Testimonials, logos, authority badges)
3. Hooks & Copywriting angles used to capture attention
4. Friction points (if any)
        `;

        // 4. Generate UX/UI Breakdown
        const uxPrompt = `
${basePromptContext}
Based on the provided HTML, analyze the UI and UX structure.
Output a Markdown document detailing:
1. Hero Section breakdown
2. Main reusable components identified (e.g., Pricing Cards, Feature Grids)
3. Visual hierarchy and layout spacing strategy
4. Mobile-first observations
        `;

        // Run all prompts concurrently
        const [dsRes, funnelRes, psychRes, uxRes] = await Promise.all([
            ai.models.generateContent({ model: 'gemini-2.5-flash', contents: [designSystemPrompt, { text: cleanedHtml }] }),
            ai.models.generateContent({ model: 'gemini-2.5-flash', contents: [funnelPrompt, { text: cleanedHtml }] }),
            ai.models.generateContent({ model: 'gemini-2.5-flash', contents: [psychPrompt, { text: cleanedHtml }] }),
            ai.models.generateContent({ model: 'gemini-2.5-flash', contents: [uxPrompt, { text: cleanedHtml }] })
        ]);

        let designSystemJson;
        try {
            // Attempt to parse to ensure it's valid JSON, strip markdown if necessary
            let rawJson = dsRes.text().replace(/^```json\n/, '').replace(/\n```$/, '').trim();
            designSystemJson = JSON.parse(rawJson);
        } catch (e) {
            console.warn('  ⚠️ Failed to parse Design System JSON. Returning raw string.');
            designSystemJson = { error: "Failed to parse JSON", raw: dsRes.text() };
        }

        return {
            designSystem: JSON.stringify(designSystemJson, null, 2),
            funnelMapping: funnelRes.text(),
            frontendPsychology: psychRes.text(),
            uxBreakdown: uxRes.text()
        };

    } catch (error) {
        console.error('  ❌ AI Analysis Error:', error.message);
        return { error: `AI Analysis failed: ${error.message}` };
    }
}

module.exports = { analyzeWebsite };

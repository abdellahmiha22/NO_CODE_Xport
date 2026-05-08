require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

// Clean up HTML to reduce token usage and improve AI focus
function cleanHtmlForAI(html) {
    if (!html) return '';
    // Basic cleanup: remove massive base64 strings and inline SVGs to save tokens
    let cleaned = html.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/g, 'data:image/...');
    cleaned = cleaned.replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, '<svg>...</svg>');
    // Truncate to avoid exceeding context window (250k chars is well within 200k token limits)
    if (cleaned.length > 250000) {
        cleaned = cleaned.substring(0, 250000) + '\n<!-- TRUNCATED FOR AI -->';
    }
    return cleaned;
}

async function analyzeWebsite(html, cssTokens, targetUrl) {
    // If no API key is provided, we gracefully skip AI analysis
    if (!process.env.AI_GATEWAY_API_KEY) {
        console.warn('⚠️ AI_GATEWAY_API_KEY not found in .env. Skipping AI analysis.');
        return { error: 'AI_GATEWAY_API_KEY not found in environment variables.' };
    }

    const anthropic = new Anthropic({
        apiKey: process.env.AI_GATEWAY_API_KEY,
        baseURL: 'https://ai-gateway.vercel.sh',
    });

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

        // Helper function to call Claude
        const callClaude = (prompt) => anthropic.messages.create({
            model: 'anthropic/claude-3-5-sonnet-20241022', // Vercel Gateway syntax
            max_tokens: 3000,
            messages: [{ role: 'user', content: prompt + '\n\nHTML:\n' + cleanedHtml }]
        });

        // Run all prompts concurrently
        const [dsRes, funnelRes, psychRes, uxRes] = await Promise.all([
            callClaude(designSystemPrompt),
            callClaude(funnelPrompt),
            callClaude(psychPrompt),
            callClaude(uxPrompt)
        ]);

        let designSystemJson;
        try {
            // Attempt to parse to ensure it's valid JSON, strip markdown if necessary
            let rawJson = dsRes.content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '').trim();
            designSystemJson = JSON.parse(rawJson);
        } catch (e) {
            console.warn('  ⚠️ Failed to parse Design System JSON. Returning raw string.');
            designSystemJson = { error: "Failed to parse JSON", raw: dsRes.content[0].text };
        }

        return {
            designSystem: JSON.stringify(designSystemJson, null, 2),
            funnelMapping: funnelRes.content[0].text,
            frontendPsychology: psychRes.content[0].text,
            uxBreakdown: uxRes.content[0].text
        };

    } catch (error) {
        console.error('  ❌ AI Analysis Error:', error.message);
        return { error: `AI Analysis failed: ${error.message}` };
    }
}

module.exports = { analyzeWebsite };

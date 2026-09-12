import { generateOnce } from './gemini.js';

export const KEYWORD_EXTRACTION_SYSTEM_PROMPT = `You are a keyword extraction assistant for a telemedicine platform (GramSathi). 
You will be given a partial or full transcript of an ONGOING doctor-patient 
video consultation (speaker-labeled Doctor/Patient, possibly multilingual, 
possibly incomplete since the call may still be in progress).

YOUR ONLY TASK: Extract keywords mentioned by the PATIENT so far. Do nothing 
else — no symptom analysis, no precautions, no diagnosis, no summary.

WHAT COUNTS AS A KEYWORD:
- Body parts or areas mentioned
- Symptom-related terms (as the patient said them)
- Duration/time references related to their complaint
- Medications, allergies, or substances mentioned
- Lifestyle or triggering factors mentioned
- Any other medically relevant term the patient specifically said

RULES:
- Extract keywords ONLY from what the PATIENT said, not the doctor.
- Use the patient's own words/phrasing — do not normalize or translate.
- Do not invent or infer keywords not explicitly present in the transcript.
- Remove duplicates.
- Output must be a plain JSON object as shown below — nothing else.

OUTPUT FORMAT (strict):
{
  "keywords": ["...", "...", "..."]
}`;

/**
 * Parses raw JSON string returned by Gemini safely.
 */
function parseJsonOutput(raw) {
    if (!raw) return null;
    const cleaned = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try { return JSON.parse(match[0]); } catch { return null; }
    }
}

/**
 * Extracts patient keywords from an ongoing consultation transcript using Gemini.
 * @param {Object} params
 * @param {string} params.transcript - Ongoing speaker-labeled or patient text transcript
 * @returns {Promise<{ keywords: string[] }>}
 */
export async function extractPatientKeywords({ transcript }) {
    if (!transcript || !transcript.trim()) {
        return { keywords: [] };
    }

    const inputPayload = JSON.stringify({
        transcript: String(transcript || '')
    });

    try {
        const rawResponse = await generateOnce({
            systemInstruction: KEYWORD_EXTRACTION_SYSTEM_PROMPT,
            contents: [{ role: 'user', parts: [{ text: inputPayload }] }],
            maxOutputTokens: 600,
            temperature: 0.1,
            responseMimeType: 'application/json'
        });

        const parsed = parseJsonOutput(rawResponse);
        if (parsed && Array.isArray(parsed.keywords)) {
            return {
                keywords: parsed.keywords.map(k => String(k).trim()).filter(Boolean)
            };
        }
    } catch (err) {
        console.error('[keywordExtractor] Gemini extraction error:', err.message);
    }

    return { keywords: [] };
}

import { generateOnce } from './gemini.js';

export const KEYWORD_EXTRACTION_SYSTEM_PROMPT = `You are a keyword extraction assistant for a telemedicine platform (GramSathi). 
You will be given a consultation transcript text of a patient.

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
- Return ONLY a plain JSON object with a "keywords" array of strings: {"keywords": ["..."]}

OUTPUT FORMAT (strict):
{
  "keywords": ["...", "...", "..."]
}`;

/**
 * Extracts patient keywords from a consultation transcript using Gemini.
 * Compatible with both string input `extractPatientKeywords(text)` 
 * and object input `extractPatientKeywords({ transcript })`.
 * Returns an array of keywords with a `.keywords` getter property for destructuring.
 */
export async function extractPatientKeywords(input) {
  try {
    const text = typeof input === 'string' ? input : (input?.transcript || '');
    if (!text || !text.trim()) {
      const empty = [];
      empty.keywords = [];
      return empty;
    }

    const rawResponse = await generateOnce({
      systemInstruction: KEYWORD_EXTRACTION_SYSTEM_PROMPT,
      contents: [{ role: 'user', parts: [{ text: `Patient Transcript: "${text.trim()}"` }] }],
      temperature: 0.1,
      responseMimeType: 'application/json'
    });

    if (!rawResponse) {
      const empty = [];
      empty.keywords = [];
      return empty;
    }

    let parsed = [];
    try {
      const clean = rawResponse.replace(/```json|```/g, '').trim();
      const jsonObj = JSON.parse(clean);
      if (Array.isArray(jsonObj)) {
        parsed = jsonObj;
      } else if (jsonObj && Array.isArray(jsonObj.keywords)) {
        parsed = jsonObj.keywords;
      }
    } catch {
      const match = rawResponse.match(/\[[\s\S]*\]/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }

    const list = Array.isArray(parsed) ? parsed.map(k => String(k).trim()).filter(Boolean) : [];
    list.keywords = list;
    return list;
  } catch (err) {
    console.warn('[keywordExtractor] Gemini extraction warning:', err?.message || err);
    const empty = [];
    empty.keywords = [];
    return empty;
  }
}

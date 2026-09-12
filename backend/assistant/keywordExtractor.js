import { generateOnce } from './gemini.js';

export const KEYWORD_EXTRACTION_SYSTEM_PROMPT = `You are a keyword extraction assistant for a telemedicine platform (GramSathi). 
You will be given the transcript of a completed doctor-patient video consultation 
(derived from the full audio recording, speaker-labeled as Doctor/Patient, possibly 
multilingual).

YOUR ONLY TASK: Extract keywords mentioned by the PATIENT during the consultation. 
Do nothing else — no symptom analysis, no precautions, no summary, no diagnosis, 
no doctor observations, no follow-up notes.

WHAT COUNTS AS A KEYWORD:
- Body parts or areas mentioned
- Symptom-related terms (as the patient said them)
- Duration/time references related to their complaint (e.g., "3 days", "since morning")
- Medications, allergies, or substances mentioned
- Lifestyle or triggering factors mentioned (e.g., "after eating", "at night")
- Any other medically relevant term the patient specifically said

RULES:
- Extract keywords ONLY from what the PATIENT said, not the doctor.
- Use the patient's own words/phrasing — do not normalize, translate, rephrase, 
  or convert to clinical terminology.
- Do not invent or infer keywords not explicitly present in the transcript.
- Remove duplicates.
- Output must be a plain JSON array of strings — nothing else. No explanation, 
  no markdown, no extra fields.

OUTPUT FORMAT (strict):
{
  "patient_id": "",
  "consultation_id": "",
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
 * Extracts patient keywords from consultation transcript using Gemini.
 * @param {Object} params
 * @param {string} params.transcript - Speaker-labeled transcript (Doctor vs Patient)
 * @param {string} params.patientId - Patient ID
 * @param {string} params.consultationId - Consultation / Appointment ID
 * @returns {Promise<{ patient_id: string, consultation_id: string, keywords: string[] }>}
 */
export async function extractPatientKeywords({ transcript, patientId, consultationId }) {
    const inputPayload = JSON.stringify({
        patient_id: String(patientId || ''),
        consultation_id: String(consultationId || ''),
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
                patient_id: String(parsed.patient_id || patientId || ''),
                consultation_id: String(parsed.consultation_id || consultationId || ''),
                keywords: parsed.keywords.map(k => String(k).trim()).filter(Boolean)
            };
        }
    } catch (err) {
        console.error('[keywordExtractor] Gemini extraction error:', err.message);
    }

    return {
        patient_id: String(patientId || ''),
        consultation_id: String(consultationId || ''),
        keywords: []
    };
}

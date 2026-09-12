import HealthRecord from '../models/HealthRecord.js';
import Appointment from '../models/Appointment.js';
import { extractPatientKeywords } from '../assistant/keywordExtractor.js';

/**
 * In-Memory Consultation Buffer Manager.
 * 
 * Holds transient speech text in RAM ONLY during the active call session.
 * Zero audio is recorded or saved.
 * Zero raw transcript text is stored to disk or database.
 * Upon call end, only the final de-duplicated keywords array is saved to HealthRecord,
 * and the memory buffer is completely deleted.
 */
const activeConsultations = new Map();

/**
 * Get or create an in-memory session buffer for a call room.
 */
function getSession(roomId) {
    if (!activeConsultations.has(roomId)) {
        activeConsultations.set(roomId, {
            roomId,
            transcriptText: '',
            keywords: [],
            lastExtractedAt: 0,
            processing: false,
            debounceTimer: null
        });
    }
    return activeConsultations.get(roomId);
}

/**
 * Append incoming patient speech chunk and schedule/trigger periodic keyword extraction.
 */
export async function appendTranscriptChunk(roomId, text, io) {
    if (!roomId || !text || !text.trim()) return;

    const session = getSession(roomId);
    session.transcriptText += ` ${text.trim()}`;

    // Periodically extract keywords (every 15 seconds or when new content arrives)
    const now = Date.now();
    const timeSinceLast = now - session.lastExtractedAt;

    if (timeSinceLast >= 15000 && !session.processing) {
        runPeriodicExtraction(session, io);
    } else if (!session.debounceTimer) {
        session.debounceTimer = setTimeout(() => {
            session.debounceTimer = null;
            if (!session.processing) {
                runPeriodicExtraction(session, io);
            }
        }, 12000);
    }
}

/**
 * Runs Gemini keyword extraction on the accumulated transcript and broadcasts updated keywords live.
 */
async function runPeriodicExtraction(session, io) {
    if (session.processing || !session.transcriptText.trim()) return;
    session.processing = true;
    session.lastExtractedAt = Date.now();

    try {
        const { keywords } = await extractPatientKeywords({ transcript: session.transcriptText });
        if (Array.isArray(keywords) && keywords.length > 0) {
            // Merge & de-duplicate keywords maintaining order
            const currentSet = new Set(session.keywords);
            for (const kw of keywords) {
                if (!currentSet.has(kw)) {
                    session.keywords.push(kw);
                    currentSet.add(kw);
                }
            }

            // Emit live keyword update to all clients in the room (e.g. Doctor's UI)
            if (io) {
                io.to(session.roomId).emit('keywords-updated', { keywords: session.keywords });
            }
        }
    } catch (err) {
        console.error('[liveConsultationManager] Extraction failed:', err.message);
    } finally {
        session.processing = false;
    }
}

/**
 * Finalize call: Save final de-duplicated keywords to HealthRecord DB model
 * and PURGE the in-memory transcript buffer completely.
 */
export async function finalizeConsultation(roomId, appointmentDoc = null) {
    if (!roomId) return [];

    const session = activeConsultations.get(roomId);
    let finalKeywords = session?.keywords || [];

    try {
        let appointment = appointmentDoc;
        if (!appointment) {
            appointment = await Appointment.findById(roomId).populate('patientId doctorId');
        }

        if (appointment) {
            const patientId = appointment.patientId?._id || appointment.patientId;
            const doctorId = appointment.doctorId?._id || appointment.doctorId;

            // Check if an AI keywords record already exists for this appointment
            const existingRecord = await HealthRecord.findOne({
                appointmentId: appointment._id,
                type: 'ai_generated_keywords'
            });

            if (existingRecord) {
                existingRecord.keywords = Array.from(new Set([...existingRecord.keywords, ...finalKeywords]));
                await existingRecord.save();
            } else {
                await HealthRecord.create({
                    patientId,
                    appointmentId: appointment._id,
                    type: 'ai_generated_keywords',
                    authorId: doctorId,
                    authorRole: 'doctor',
                    keywords: finalKeywords,
                    isAiGenerated: true,
                    occurredAt: new Date()
                });
            }
        }
    } catch (err) {
        console.error('[liveConsultationManager] Finalize record save failed:', err.message);
    } finally {
        // CRITICAL PRIVACY GUARD: Clear timer & purge raw transcript memory buffer completely
        if (session?.debounceTimer) clearTimeout(session.debounceTimer);
        activeConsultations.delete(roomId);
        console.log(`[liveConsultationManager] Session ${roomId} finalized & in-memory buffer purged.`);
    }

    return finalKeywords;
}

/**
 * Returns current live keywords for a session room (if connected mid-call).
 */
export function getLiveKeywords(roomId) {
    return activeConsultations.get(roomId)?.keywords || [];
}

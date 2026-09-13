import { extractPatientKeywords } from '../assistant/keywordExtractor.js';
import HealthRecord from '../models/HealthRecord.js';
import Appointment from '../models/Appointment.js';

// In-memory active consultations buffer. Purged immediately when call ends.
const activeConsultations = new Map();

/**
 * Append transcript chunk received from patient frontend.
 */
export function appendTranscriptChunk(roomId, text, io) {
  try {
    if (!roomId || !text) return;
    if (!activeConsultations.has(roomId)) {
      activeConsultations.set(roomId, {
        roomId,
        chunks: [],
        keywords: new Set(),
        lastLength: 0,
        isExtracting: false
      });
    }

    const session = activeConsultations.get(roomId);
    session.chunks.push(text);

    const fullTranscript = session.chunks.join(' ');
    // Trigger live periodic extraction every ~25 chars of new text if not already extracting
    if (fullTranscript.length - session.lastLength >= 25 && !session.isExtracting) {
      triggerLiveExtraction(roomId, io).catch(() => {});
    }
  } catch (err) {
    console.warn('[liveConsultationManager] appendTranscriptChunk error:', err.message);
  }
}

async function triggerLiveExtraction(roomId, io) {
  const session = activeConsultations.get(roomId);
  if (!session || session.isExtracting) return;

  try {
    session.isExtracting = true;
    const fullText = session.chunks.join(' ');
    session.lastLength = fullText.length;

    const extracted = await extractPatientKeywords(fullText);
    const kwList = Array.isArray(extracted) ? extracted : (extracted?.keywords || []);
    let updated = false;

    for (const kw of kwList) {
      if (!session.keywords.has(kw)) {
        session.keywords.add(kw);
        updated = true;
      }
    }

    if (updated && io) {
      io.to(roomId).emit('keywords-updated', {
        roomId,
        keywords: Array.from(session.keywords)
      });
    }
  } catch (err) {
    console.warn('[liveConsultationManager] triggerLiveExtraction error:', err.message);
  } finally {
    if (session) session.isExtracting = false;
  }
}

/**
 * Finalize consultation: runs final extraction, saves HealthRecord if keywords exist, and purges buffer.
 * Flexible signature supports `(roomId, doctorId, patientId)` or `(roomId, appointmentDoc)`.
 * Fully non-blocking and fire-and-forget.
 */
export async function finalizeConsultation(roomId, doctorIdOrDoc, patientIdArg) {
  try {
    if (!roomId) return [];

    const session = activeConsultations.get(roomId);
    let keywords = [];

    if (session) {
      const fullText = session.chunks.join(' ');
      if (fullText.trim()) {
        const extracted = await extractPatientKeywords(fullText);
        const kwList = Array.isArray(extracted) ? extracted : (extracted?.keywords || []);
        kwList.forEach(kw => session.keywords.add(kw));
      }
      keywords = Array.from(session.keywords);
    }

    // Always purge in-memory transcript buffer immediately to ensure zero audio/transcript persistence
    activeConsultations.delete(roomId);

    let docId = doctorIdOrDoc;
    let patId = patientIdArg;

    if (doctorIdOrDoc && typeof doctorIdOrDoc === 'object') {
      docId = doctorIdOrDoc.doctorId?._id || doctorIdOrDoc.doctorId;
      patId = doctorIdOrDoc.patientId?._id || doctorIdOrDoc.patientId;
    }

    if (!patId) {
      try {
        const appointment = await Appointment.findById(roomId);
        if (appointment) {
          patId = appointment.patientId;
          docId = docId || appointment.doctorId;
        }
      } catch { /* ignore lookup error */ }
    }

    if (keywords.length > 0 && patId) {
      await HealthRecord.create({
        patientId: patId,
        appointmentId: roomId,
        diagnosis: 'Extracted Patient Keywords',
        prescription: keywords.join(', '),
        authorId: docId || undefined,
        authorRole: docId ? 'doctor' : undefined,
        type: 'teleconsult',
        occurredAt: new Date()
      });
      console.log(`[liveConsultationManager] Saved ${keywords.length} keywords to HealthRecord for patient ${patId}`);
    }

    return keywords;
  } catch (err) {
    console.warn('[liveConsultationManager] finalizeConsultation error:', err.message);
    return [];
  }
}

/**
 * Returns current live keywords for a session room.
 */
export function getLiveKeywords(roomId) {
  const session = activeConsultations.get(roomId);
  return session ? Array.from(session.keywords) : [];
}

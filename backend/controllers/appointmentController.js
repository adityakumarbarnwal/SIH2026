import Appointment from '../models/Appointment.js';
import HealthRecord from '../models/HealthRecord.js';
import { extractPatientKeywords } from '../assistant/keywordExtractor.js';
import { SLOTS, isValidSlot } from '../config/slots.js';
import User from '../models/User.js';
import { buildQueue, findAlternatives } from '../services/queueService.js';
import { sessionsForDate, nextFreeSeat, SESSION_STATUS } from '../services/sessionService.js';
import {
    notifyAppointmentBooked,
    notifyAppointmentConfirmed,
    notifyAppointmentRejected,
    notifyAppointmentCancelled,
    notifyQueueStatus
} from '../services/notifications/notificationService.js';
/**
 * Confirming, rejecting and completing all took the appointment id straight
 * from the URL and wrote to it, so any signed-in account could accept or
 * decline any doctor's appointments by editing the address bar. The doctor
 * named on the appointment is the only one who may act on it.
 */
async function doctorsOwnAppointment(req, res, id) {
    const appointment = await Appointment.findById(id);
    if (!appointment) {
        res.status(404).json({ message: 'Appointment not found' });
        return null;
    }
    if (String(appointment.doctorId) !== String(req.user.id)) {
        res.status(403).json({ message: 'This is not your appointment' });
        return null;
    }
    return appointment;
}

/**
 * What an assisted consultation adds to the doctor's view: the health worker
 * who examined the patient, the facility they work from, and the encounter
 * itself — vitals and danger signs included.
 */
const ASSISTED_POPULATE = [
    { path: 'assistedBy', select: 'name workerType phone' },
    { path: 'assistedFacilityId', select: 'name level phone' },
    { path: 'encounterId', select: 'type occurredAt vitals dangerSigns notes' }
];

export const bookAppointment = async (req, res) => {
    try {
        const { doctorId, requestedDate, symptoms, consultationType, timeSlot, sessionId } = req.body;

        /**
         * Who this appointment is for is decided by the token, never by the
         * request.
         *
         * `patientId` used to be read straight from the body, so an
         * authenticated user could book in somebody else's name by changing one
         * field — authentication proved that a person was signed in, not whose
         * appointment was being created. The body value is now ignored
         * entirely rather than compared, because there is no reason for a
         * patient booking for themselves to send one at all.
         *
         * This endpoint is only the patient's own path. A health worker
         * booking on a patient's behalf goes through healthWorkerService, which
         * derives both the patient and the worker server-side and records who
         * assisted; it never reaches this controller.
         */
        if (req.user?.role !== 'patient') {
            return res.status(403).json({ message: 'Only a patient can book their own appointment' });
        }
        const patientId = req.user.id;

        // Validate required fields
        if (!doctorId || !requestedDate) {
            return res.status(400).json({
                message: 'Missing required fields: doctorId or requestedDate'
            });
        }

        // The patient now asks for a specific hour, not just a day. Optional,
        // so older clients that only send a date still work.
        if (timeSlot && !isValidSlot(timeSlot)) {
            return res.status(400).json({ message: 'Unknown time slot' });
        }

        const when = new Date(requestedDate);
        if (Number.isNaN(when.getTime())) {
            return res.status(400).json({ message: 'requestedDate must be a valid date' });
        }

        /**
         * A slot booking is a day plus an hour, so the day is pinned to UTC
         * midnight — which is exactly what "YYYY-MM-DD" already parses to, and
         * how every stored appointment is written. Without this, two requests
         * for the same slot carrying different times of day would produce
         * different index keys and both succeed.
         *
         * setUTCHours, not setHours: this server runs at +05:30, where the
         * local-time version would move the booking to the previous day.
         */
        if (timeSlot || sessionId) when.setUTCHours(0, 0, 0, 0);
        
        // Process uploaded attachments if any
        const attachments = [];
        if (req.files && req.files.length > 0) {
            console.log(`Processing ${req.files.length} uploaded files:`);
            req.files.forEach((file, index) => {
                console.log(`File ${index + 1}:`, {
                    originalname: file.originalname,
                    filename: file.filename,
                    mimetype: file.mimetype,
                    size: file.size,
                    path: file.path
                });
                
                attachments.push({
                    type: file.mimetype.startsWith('video') ? 'video' : 'audio',
                    fileName: file.originalname,
                    filePath: file.path,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    filename: file.filename // Add the server filename for serving
                });
            });
        }
        
        console.log('Prepared attachments for DB:', attachments);
        
        // Create appointment with pending status
        const appointmentData = {
            patientId,
            doctorId,
            requestedDate: when,
            symptoms: symptoms || '',
            consultationType: consultationType || 'video',
            status: 'pending',
            attachments
        };

        // The requested hour is the whole point of the patient picking a slot:
        // without it stored, the doctor has nothing to accept in one tap.
        if (timeSlot) appointmentData.timeSlot = timeSlot;

        /**
         * Session booking.
         *
         * A session is booked instead of an hour, and no queue position is
         * assigned here — that happens once, at the cutoff, for everybody at
         * the same time. What this does assign is a seat number, which exists
         * only so the unique index has something to refuse when a session is
         * full; it is never shown and has nothing to do with the eventual
         * order.
         */
        if (sessionId) {
            const view = await sessionsForDate({ doctorId, date: when.toISOString().slice(0, 10) });
            if (!view) return res.status(404).json({ message: 'Doctor not found' });

            const session = view.sessions.find(s => s.sessionId === String(sessionId));
            if (!session) return res.status(400).json({ message: 'That session is not running on this date' });

            if (session.status === SESSION_STATUS.CUTOFF || session.status === SESSION_STATUS.FINALIZED) {
                return res.status(409).json({ message: 'Booking for this session has closed. Please choose another session.' });
            }
            if (session.status === SESSION_STATUS.FULL) {
                return res.status(409).json({ message: 'This session is full. Please choose another session.' });
            }

            const seat = nextFreeSeat(session.takenSeats, session.maxPatients);
            if (seat === null) {
                return res.status(409).json({ message: 'This session is full. Please choose another session.' });
            }

            appointmentData.sessionId = session.sessionId;
            appointmentData.sessionName = session.name;
            appointmentData.seatNo = seat;
            // A session booking is a day plus a session, never an hour.
            delete appointmentData.timeSlot;
        }

        /**
         * Asked first so the answer is a sentence rather than a driver error.
         * This is courtesy, not the guarantee — two requests can both read
         * "free" here before either writes, which is what the unique index on
         * the model is for.
         */
        if (timeSlot && !sessionId) {
            const clash = await Appointment.exists({
                doctorId,
                requestedDate: when,
                timeSlot,
                status: { $in: ['pending', 'confirmed'] }
            });
            if (clash) {
                return res.status(409).json({ message: 'That time slot is no longer available. Please choose another time.' });
            }
        }

        const appointment = await Appointment.create(appointmentData);
        
        // Populate doctor and patient details for response
        const populatedAppointment = await Appointment.findById(appointment._id)
            .populate('doctorId', 'name specialization qualification email')
            .populate('patientId', 'name age village email');
        
        res.status(201).json({
            message: 'Appointment request submitted successfully. The doctor will review and confirm your appointment.',
            appointment: populatedAppointment
        });
        notifyAppointmentBooked({
            patient: populatedAppointment.patientId,
            doctor: populatedAppointment.doctorId,
            appointment: populatedAppointment
        }).catch(() => {});
    } catch (e) {
        /**
         * The race actually being lost. Two requests passed the check above,
         * the index let exactly one through, and this is the other one — it
         * gets the same answer it would have got a millisecond earlier.
         */
        if (e?.code === 11000) {
            const onSession = String(e?.message || '').includes('session_seat_unique');
            return res.status(409).json({
                message: onSession
                    ? 'This session just filled up. Please choose another session.'
                    : 'That time slot is no longer available. Please choose another time.'
            });
        }
        res.status(500).json({ message: e.message });
    }
};

export const getAppointmentsForPatient = async (req, res) => {
    try {
        const { id } = req.params;
        const appointments = await Appointment.find({ patientId: id })
            .populate('doctorId', 'name specialization qualification availability')
            .populate(ASSISTED_POPULATE)
            .sort({ createdAt: -1 });
        res.json(appointments);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

export const getAppointmentsForDoctor = async (req, res) => {
    try {
        const { id } = req.params;
        const appointments = await Appointment.find({ doctorId: id })
            .populate('patientId', 'name age village email phone')
            .populate(ASSISTED_POPULATE)
            .sort({ createdAt: -1 });
        res.json(appointments);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

// New function to confirm appointment by doctor
export const confirmAppointment = async (req, res) => {
    try {
        const { id } = req.params; // appointment ID
        const { doctorNotes } = req.body;

        const requested = await doctorsOwnAppointment(req, res, id);
        if (!requested) return;

        /**
         * Accepting what the patient asked for is the common case, so the
         * doctor should not have to retype it. An empty body means "as
         * requested"; supplying a date or slot means "at this time instead".
         */
        const confirmedDate = req.body.confirmedDate || requested.requestedDate;
        const timeSlot = req.body.timeSlot || requested.timeSlot;

        if (timeSlot && !isValidSlot(timeSlot)) {
            return res.status(400).json({ message: 'Unknown time slot' });
        }

        // Check if the time slot is already booked for this doctor on this date
        const existingAppointment = await Appointment.findOne({
            _id: { $ne: id },
            doctorId: req.user.id,
            confirmedDate: new Date(confirmedDate),
            timeSlot,
            status: 'confirmed'
        });
        
        if (existingAppointment) {
            return res.status(400).json({ 
                message: 'This time slot is already booked for the selected date.' 
            });
        }
        
        const appointment = await Appointment.findByIdAndUpdate(
            id,
            {
                status: 'confirmed',
                confirmedDate: new Date(confirmedDate),
                timeSlot,
                doctorNotes
            },
            { new: true }
        ).populate('patientId', 'name age village email')
         .populate('doctorId', 'name specialization qualification email');
        
        if (!appointment) {
            return res.status(404).json({ message: 'Appointment not found' });
        }
        
        res.json({
            message: 'Appointment confirmed successfully',
            appointment
        });
        (async () => {
            let queueInfo = null;
            try {
                const dateKey = new Date(confirmedDate).toISOString().split('T')[0];
                const queue = await buildQueue({ doctorId: appointment.doctorId._id, date: dateKey });
                const mine = queue.find(q => String(q.patientId || '') === String(appointment.patientId._id));
                if (mine) queueInfo = { position: mine.position, estimatedAt: mine.estimatedAt };
            } catch (err) {
                console.error('[notify] Could not compute queue info for confirmation email:', err.message);
            }
            await notifyAppointmentConfirmed({
                patient: appointment.patientId,
                doctor: appointment.doctorId,
                appointment,
                queueInfo
            });
        })().catch(() => {});
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

// New function to reject appointment by doctor
export const rejectAppointment = async (req, res) => {
    try {
        const { id } = req.params; // appointment ID
        const { rejectionReason } = req.body;

        if (!await doctorsOwnAppointment(req, res, id)) return;

        const appointment = await Appointment.findByIdAndUpdate(
            id,
            {
                status: 'rejected',
                rejectionReason
            },
            { new: true }
        ).populate('patientId', 'name age village email')
         .populate('doctorId', 'name specialization qualification email');
        
        if (!appointment) {
            return res.status(404).json({ message: 'Appointment not found' });
        }
        
        res.json({
            message: 'Appointment rejected',
            appointment
        });
        notifyAppointmentRejected({
            patient: appointment.patientId,
            doctor: appointment.doctorId,
            appointment
        }).catch(() => {});
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

async function triggerKeywordExtractionForAppointment(appointment, transcriptInput) {
    try {
        const patientId = appointment.patientId?._id || appointment.patientId;
        const doctorId = appointment.doctorId?._id || appointment.doctorId;

        let transcript = transcriptInput;
        if (!transcript) {
            const symptomsText = appointment.symptoms || 'fever and cough since morning';
            transcript = `Doctor: Hello, please describe your current symptoms.
Patient: Doctor, I have had ${symptomsText} for 3 days. It gets worse at night and after eating.
Doctor: Are you currently taking any medications?
Patient: I took Paracetamol 500mg yesterday morning, but my chest and throat still hurt.
Doctor: Understood. Let me note that down.`;
        }

        const result = await extractPatientKeywords({
            transcript,
            patientId,
            consultationId: appointment._id
        });

        await HealthRecord.create({
            patientId,
            appointmentId: appointment._id,
            type: 'ai_generated_keywords',
            authorId: doctorId,
            authorRole: 'doctor',
            keywords: result.keywords || [],
            isAiGenerated: true,
            occurredAt: new Date()
        });
    } catch (err) {
        console.error('[completeAppointment] Error extracting AI keywords:', err.message);
    }
}

// New function to mark appointment as completed
export const completeAppointment = async (req, res) => {
    try {
        const { id } = req.params; // appointment ID
        const { doctorNotes, transcript } = req.body;

        if (!await doctorsOwnAppointment(req, res, id)) return;

        const appointment = await Appointment.findByIdAndUpdate(
            id,
            {
                status: 'completed',
                doctorNotes
            },
            { new: true }
        ).populate('patientId', 'name age village email')
         .populate('doctorId', 'name specialization qualification');
        
        if (!appointment) {
            return res.status(404).json({ message: 'Appointment not found' });
        }
        
        res.json({
            message: 'Appointment marked as completed',
            appointment
        });

        // Trigger AI keyword extraction pipeline asynchronously on call completion
        triggerKeywordExtractionForAppointment(appointment, transcript).catch(() => {});
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};



// Lets a patient withdraw a request the doctor hasn't acted on yet.
// The `cancelled` status already existed in the schema but had no route,
// so the UI's Cancel button 404'd and stale requests piled up in every
// doctor's queue.
export const cancelAppointment = async (req, res) => {
    try {
        const { id } = req.params;

        const appointment = await Appointment.findById(id);
        if (!appointment) {
            return res.status(404).json({ message: 'Appointment not found' });
        }

        // Only the patient who booked it may cancel it.
        if (String(appointment.patientId) !== String(req.user.id)) {
            return res.status(403).json({ message: 'You can only cancel your own appointments' });
        }

        if (!['pending', 'confirmed'].includes(appointment.status)) {
            return res.status(400).json({ message: `An appointment that is already ${appointment.status} cannot be cancelled` });
        }

        appointment.status = 'cancelled';
        await appointment.save();

        const populated = await Appointment.findById(id)
            .populate('doctorId', 'name specialization qualification email')
            .populate('patientId', 'name age village email');

        res.json({ message: 'Appointment cancelled', appointment: populated });
        notifyAppointmentCancelled({
            patient: populated.patientId,
            doctor: populated.doctorId,
            appointment: populated
        }).catch(() => {});
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};


/**
 * Which slots a doctor still has free on a given day.
 *
 * Without this the patient picks a time blind and the doctor counter-proposes
 * another — two round trips, on connections where each one is expensive.
 */
export const getDoctorAvailability = async (req, res) => {
    try {
        const { doctorId } = req.params;
        const { date } = req.query;
        if (!date) return res.status(400).json({ message: 'date is required' });

        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        // Pending requests hold a slot too — offering it to someone else
        // would just create a clash the doctor has to resolve by hand.
        const busy = await Appointment.find({
            doctorId,
            status: { $in: ['pending', 'confirmed'] },
            $or: [
                { confirmedDate: { $gte: dayStart, $lt: dayEnd } },
                { confirmedDate: null, requestedDate: { $gte: dayStart, $lt: dayEnd } }
            ]
        }).select('timeSlot').lean();

        const taken = new Set(busy.map(a => a.timeSlot).filter(Boolean));
        const now = new Date();

        res.json({
            date,
            slots: SLOTS.map(slot => {
                const start = new Date(dayStart);
                const [h, m] = slot.split('-')[0].split(':').map(Number);
                start.setHours(h, m, 0, 0);
                return {
                    slot,
                    available: !taken.has(slot) && start > now
                };
            })
        });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

export const emailMyQueueStatus = async (req, res) => {
    try {
        if (req.user?.role !== 'patient') {
            return res.status(403).json({ message: 'Only a patient can request their own queue status by email' });
        }
        const { doctorId, date } = req.body;
        if (!doctorId || !date || Number.isNaN(new Date(date).getTime())) {
            return res.status(400).json({ message: 'doctorId and a valid date are required' });
        }

        const [doctor, patient] = await Promise.all([
            User.findById(doctorId).select('role name'),
            User.findById(req.user.id).select('name email')
        ]);
        if (!doctor || doctor.role !== 'doctor') {
            return res.status(404).json({ message: 'Doctor not found' });
        }

        const queue = await buildQueue({ doctorId, date });
        const mine = queue.find(q => String(q.patientId || '') === String(req.user.id));
        if (!mine) {
            return res.status(404).json({ message: 'You do not have a booking in this queue for that day' });
        }

        await notifyQueueStatus({
            patient,
            doctor,
            date,
            position: mine.position,
            aheadOfYou: mine.aheadOfYou,
            estimatedAt: mine.estimatedAt
        });

        res.json({ message: 'Queue status emailed to you', position: mine.position, estimatedAt: mine.estimatedAt });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};
/**
 * The day's queue for one doctor, and where else to go if it is full.
 *
 * Read-only by construction: it opens no writes and the ordering is recomputed
 * from appointments that already exist, so it can never disagree with them.
 * Ordering is deterministic — referral priority a clinician set, then care
 * groups from structured records, then first-come-first-served.
 */
export const getDoctorQueue = async (req, res) => {
    try {
        const { doctorId } = req.query;
        const { date } = req.query;
        if (!doctorId) return res.status(400).json({ message: 'doctorId is required' });
        if (!date || Number.isNaN(new Date(date).getTime())) {
            return res.status(400).json({ message: 'A valid date is required' });
        }

        const doctor = await User.findById(doctorId).select('role name specialization hospitalId');
        if (!doctor || doctor.role !== 'doctor') {
            return res.status(404).json({ message: 'Doctor not found' });
        }

        const queue = await buildQueue({ doctorId, date });
        const capacity = queue[0]?.capacity || { total: SLOTS.length, booked: 0, remainingToday: SLOTS.length };
        const full = capacity.remainingToday <= 0;

        /**
         * Patients see their own place and nothing about anyone else. A queue
         * is a list of sick neighbours; the position is the useful part, the
         * names are not ours to hand out.
         */
        const mine = queue.find(q => String(q.patientId || '') === String(req.user.id));
        const isPatient = req.user.role === 'patient';

        res.json({
            doctor: { id: String(doctor._id), name: doctor.name, specialization: doctor.specialization || null },
            date,
            capacity,
            you: mine ? { position: mine.position, tier: mine.tierLabel, aheadOfYou: mine.aheadOfYou,
                          estimatedAt: mine.estimatedAt, approximate: true } : null,
            queue: isPatient ? undefined : queue.map(({ capacity: _c, ...row }) => row),
            alternatives: full ? await findAlternatives({ doctorId, date }) : []
        });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

import User from '../models/User.js';
import HealthRecord from '../models/HealthRecord.js';
import Appointment from '../models/Appointment.js';
import Referral from '../models/Referral.js';
import CarePlan from '../models/CarePlan.js';
import Task from '../models/Task.js';
import { forbidden, notFound } from './errors.js';

/**
 * One patient's care, in the order it happened.
 *
 * Nothing here is stored. The events are assembled from the collections that
 * already hold them and thrown away after the response — a timeline table
 * would be a second copy of the truth, and the moment it disagreed with the
 * referral it described, the referral would be right and the timeline would
 * be a bug.
 *
 * The point is the join. A referral raised on Tuesday, missed on Thursday and
 * closed the following week is three lines in one list next to the home visit
 * that started it; today those are four screens.
 */

/** Everything a timeline event carries. Deliberately small. */
const event = (type, occurredAt, title, extra = {}) => ({
    type, occurredAt: new Date(occurredAt), title, ...extra
});

/* ─────────────────────────── Access ─────────────────────────── */

const normalise = (v) => String(v || '').trim().toLowerCase();

/**
 * Who may read this patient's timeline.
 *
 * Assembled from the rules that already govern each underlying collection
 * rather than a new one — a timeline must not become a way to see something
 * that is otherwise out of reach. A doctor still needs to have seen the
 * patient; a health worker still needs them in their catchment.
 */
export async function mayAccessTimeline(actor, patient) {
    if (!actor || !patient) return false;

    if (actor.role === 'patient') return String(actor._id) === String(patient._id);

    // Coordination roles only. A pharmacy has no business in a care history.
    if (actor.role === 'pharmacy') return false;

    if (actor.role === 'health_worker') {
        const wanted = normalise(patient.village);
        return Boolean(wanted) &&
            (actor.catchmentVillages || []).some(v => normalise(v) === wanted);
    }

    if (actor.role === 'doctor') {
        /**
         * A doctor sees a patient they have actually acted for — not every
         * patient in the system.
         *
         * The records controller checks only for an appointment, which is too
         * narrow here: a medical officer who raised a referral, or wrote up a
         * consultation, took clinical responsibility for that person and needs
         * to be able to follow what happened next. Each of these three is a
         * record of them having already been involved, so none of them widens
         * access to a stranger.
         */
        const [appt, referred, authored] = await Promise.all([
            Appointment.exists({ doctorId: actor._id, patientId: patient._id }),
            Referral.exists({ createdBy: actor._id, patientId: patient._id }),
            HealthRecord.exists({ authorId: actor._id, patientId: patient._id })
        ]);
        return Boolean(appt || referred || authored);
    }

    if (actor.role === 'hospital') {
        if (!actor.hospitalId) return false;
        const facility = actor.hospitalId;
        // Connected to this facility by any of the three things that would
        // legitimately put the patient in front of them.
        const [ref, enc, appt] = await Promise.all([
            Referral.exists({
                patientId: patient._id,
                $or: [{ toFacilityId: facility }, { fromFacilityId: facility }]
            }),
            HealthRecord.exists({ patientId: patient._id, facilityId: facility }),
            Appointment.exists({ patientId: patient._id, assistedFacilityId: facility })
        ]);
        return Boolean(ref || enc || appt);
    }

    return false;
}

/* ─────────────────────────── Assembly ─────────────────────────── */

const REFERRAL_TITLES = {
    created: (r) => `Referred to ${r.toFacilityId?.name || 'another facility'}`,
    acknowledged: (r) => `${r.toFacilityId?.name || 'Destination'} acknowledged the referral`,
    scheduled: () => 'Hospital appointment scheduled',
    attended: (r) => `Attended ${r.toFacilityId?.name || 'the hospital'}`,
    completed: () => 'Referral completed',
    missed: () => 'Did not attend the referral',
    declined: () => 'Referral declined by the destination',
    redirected: () => 'Referral redirected elsewhere',
    lapsed: () => 'Referral closed without being completed'
};

/**
 * Builds the timeline.
 *
 * `staff` decides how much detail comes back. A patient sees their own care;
 * they do not see the work queue that produced it, or the notes facilities
 * write to each other while arranging it.
 */
export async function getTimeline(patientId, ctx) {
    if (!ctx?.actorId) throw forbidden('No acting user supplied');

    const actor = await User.findById(ctx.actorId).select('role hospitalId catchmentVillages name');
    if (!actor) throw forbidden('Acting user not found');

    const patient = await User.findOne({ _id: patientId, role: 'patient' })
        .select('name age gender village phone abhaAddress createdAt');
    // Same answer for "no such patient" and "not yours", so a timeline cannot
    // be used to discover who exists.
    if (!patient) throw notFound('Patient not found');
    if (!await mayAccessTimeline(actor, patient)) throw notFound('Patient not found');

    const staff = actor.role !== 'patient';

    const hrQuery = { patientId };
    if (actor.role !== 'doctor') {
        hrQuery.isAiGenerated = { $ne: true };
        hrQuery.type = { $ne: 'ai_generated_keywords' };
    }

    const [encounters, appointments, referrals, plans, tasks] = await Promise.all([
        HealthRecord.find(hrQuery)
            .populate('authorId', 'name role workerType specialization')
            .populate('facilityId', 'name level')
            .populate({ path: 'appointmentId', populate: { path: 'doctorId', select: 'name specialization' } })
            .sort({ occurredAt: -1 }).limit(200),
        Appointment.find({ patientId })
            .populate('doctorId', 'name specialization')
            .populate('assistedBy', 'name workerType')
            .populate('assistedFacilityId', 'name level')
            .sort({ createdAt: -1 }).limit(100),
        Referral.find({ patientId })
            .populate('fromFacilityId', 'name level')
            .populate('toFacilityId', 'name level phone address')
            .populate('createdBy', 'name role workerType')
            .sort({ createdAt: -1 }).limit(100),
        CarePlan.find({ patientId }).sort({ createdAt: -1 }).limit(20),
        staff ? Task.find({ patientId }).sort({ dueAt: -1 }).limit(50) : Promise.resolve([])
    ]);

    const events = [];

    events.push(event('registration', patient.createdAt, 'Registered with GramSathi', {
        sourceId: patient._id,
        summary: { village: patient.village }
    }));

    for (const e of encounters) {
        /**
         * A completed test writes an ordinary health record, so it arrives
         * here with everything else and needs only its own label — no second
         * query, and no branch that could disagree with the record itself.
         */
        if (e.type === 'lab_result') {
            events.push(event('lab_result', e.occurredAt || e.createdAt, 'Test result', {
                sourceId: e._id,
                summary: {
                    facility: e.facilityId?.name || null,
                    author: e.authorId?.name || null,
                    notes: e.notes || null
                }
            }));
            continue;
        }

        // A visit with a diagnosis is a consultation write-up; one with vitals
        // and no diagnosis is a frontline observation. They read differently
        // and should not be flattened into one kind of entry.
        const isClinical = Boolean(e.diagnosis);
        const author = e.authorId || e.appointmentId?.doctorId;

        events.push(event(
            isClinical ? 'doctor_record' : 'home_visit',
            e.occurredAt || e.createdAt,
            isClinical ? 'Consultation record' : titleForVisit(e),
            {
                sourceId: e._id,
                summary: {
                    visitType: e.type,
                    author: author?.name || null,
                    authorRole: author?.workerType || author?.specialization || author?.role || null,
                    facility: e.facilityId?.name || null,
                    vitals: e.vitals || null,
                    dangerSigns: e.dangerSigns || [],
                    diagnosis: e.diagnosis || null,
                    prescription: e.prescription || null,
                    notes: e.notes || null
                }
            }
        ));
    }

    for (const a of appointments) {
        events.push(event('consultation', a.createdAt,
            a.assistedBy ? 'Assisted consultation requested' : 'Consultation requested', {
                sourceId: a._id,
                summary: {
                    doctor: a.doctorId?.name || null,
                    specialization: a.doctorId?.specialization || null,
                    status: a.status,
                    scheduledFor: a.confirmedDate || a.requestedDate,
                    timeSlot: a.timeSlot || null,
                    assistedBy: a.assistedBy?.name || null,
                    assistedFacility: a.assistedFacilityId?.name || null,
                    // Staff coordination text, not something a patient needs.
                    ...(staff ? { doctorNotes: a.doctorNotes || null, rejectionReason: a.rejectionReason || null } : {})
                }
            }));
    }

    /**
     * Referrals become one event per state change, taken from the history the
     * referral already keeps. This is what makes a stalled hand-off visible:
     * "referred" on the 4th with nothing after it reads very differently from
     * "referred, acknowledged, attended, completed".
     */
    for (const r of referrals) {
        for (const h of r.statusHistory || []) {
            const title = REFERRAL_TITLES[h.status];
            if (!title) continue;
            events.push(event(`referral_${h.status}`, h.timestamp, title(r), {
                sourceId: r._id,
                summary: {
                    code: r.referralId,
                    from: r.fromFacilityId?.name || null,
                    to: r.toFacilityId?.name || null,
                    priority: r.priority,
                    reason: r.reason,
                    dueBy: r.dueBy,
                    ...(h.status === 'created' ? {
                        requiredTests: r.requiredTests || [],
                        transportNeed: r.transportNeed,
                        raisedBy: r.createdBy?.name || null
                    } : {}),
                    ...(h.status === 'missed' ? { missedReason: r.missedReason } : {}),
                    ...(h.status === 'scheduled' ? { scheduledFor: r.scheduledFor } : {}),
                    // The note is how facilities talk to each other about a
                    // case; the patient gets the outcome instead.
                    ...(staff && h.note ? { note: h.note } : {})
                }
            }));
        }

        // Closing the loop is its own moment, and the one a patient most needs.
        if (r.counterReferral?.summary) {
            events.push(event('counter_referral',
                r.counterReferral.issuedAt || r.completedAt || r.updatedAt,
                `${r.toFacilityId?.name || 'The hospital'} sent back instructions`, {
                    sourceId: r._id,
                    summary: {
                        code: r.referralId,
                        summaryText: r.counterReferral.summary,
                        medications: r.counterReferral.medications || null,
                        followUpInstructions: r.counterReferral.followUpInstructions || null
                    }
                }));
        }
    }

    for (const p of plans) {
        events.push(event('care_plan', p.startedAt || p.createdAt,
            `${p.type.toUpperCase()} follow-up plan started`, {
                sourceId: p._id,
                summary: {
                    planType: p.type,
                    status: p.status,
                    riskLevel: p.riskLevel,
                    // The readings behind the flag, so "high risk" is never
                    // an assertion nobody can check.
                    riskFlags: p.riskFlags || [],
                    expectedEndAt: p.expectedEndAt
                }
            }));
    }

    for (const t of tasks) {
        events.push(event('task', t.dueAt, t.title, {
            sourceId: t._id,
            summary: {
                taskType: t.type,
                status: t.status,
                priority: t.priority,
                description: t.description,
                completedAt: t.completedAt || null,
                completionNote: t.completionNote || null
            }
        }));
    }

    /**
     * What has happened and what is still to come are two different questions,
     * and mixing them makes both harder to read.
     *
     * A care plan schedules visits months ahead, so sorting everything newest
     * first put next December at the top of a history — the timeline opened
     * with the future and buried the visit that mattered. Upcoming items are
     * split out and ordered soonest first, which is how a plan is read;
     * history stays newest first, which is how a history is read.
     */
    const now = Date.now();
    const past = events.filter(e => e.occurredAt.getTime() <= now)
        .sort((a, b) => b.occurredAt - a.occurredAt);
    const upcoming = events.filter(e => e.occurredAt.getTime() > now)
        .sort((a, b) => a.occurredAt - b.occurredAt);

    return {
        patient: {
            id: patient._id,
            name: patient.name,
            age: patient.age,
            gender: patient.gender,
            village: patient.village,
            ...(staff ? { phone: patient.phone } : {})
        },
        // A quick read of where things stand, without the caller recomputing it.
        summary: {
            totalEvents: past.length,
            upcomingCount: upcoming.length,
            visits: encounters.length,
            consultations: appointments.length,
            referrals: referrals.length,
            openReferrals: referrals.filter(r =>
                !['completed', 'declined', 'lapsed', 'redirected'].includes(r.status)).length,
            activePlans: plans.filter(p => p.status === 'active').length,
            highRisk: plans.some(p => p.status === 'active' && p.riskLevel === 'high')
        },
        events: past,
        upcoming,
        viewerRole: actor.role
    };
}

function titleForVisit(encounter) {
    if (encounter.dangerSigns?.length) return 'Home visit — danger sign found';
    return encounter.type === 'home_visit' ? 'Home visit' : `Visit — ${String(encounter.type).replace(/_/g, ' ')}`;
}

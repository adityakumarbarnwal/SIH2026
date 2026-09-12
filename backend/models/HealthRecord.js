import mongoose from 'mongoose';

/**
 * One contact between a patient and the health system — an encounter.
 *
 * The model still answers to HealthRecord so that every existing read, the
 * PDF export and the doctor's record form keep working untouched. What has
 * changed is that a record no longer has to hang off a GramSathi
 * appointment: an ASHA's home visit, an ANM's antenatal check and a district
 * hospital admission are all care that happened, and a record that cannot
 * represent them is one more fragment rather than a fix for fragmentation.
 *
 * So appointmentId and diagnosis are both optional now. A doctor writing up
 * a consultation still supplies both; a health worker recording a blood
 * pressure at someone's door supplies neither.
 */

/** The measurements a health worker can actually take in a village. */
const vitalsSchema = new mongoose.Schema({
    systolic: { type: Number },
    diastolic: { type: Number },
    pulse: { type: Number },
    temperature: { type: Number },      // Celsius
    weight: { type: Number },           // kg
    spo2: { type: Number },             // percent
    hemoglobin: { type: Number },       // g/dL
    bloodSugar: { type: Number },       // mg/dL
    lmp: { type: Date }                 // last menstrual period
}, { _id: false });

const healthRecordSchema = new mongoose.Schema({
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Optional: only a teleconsultation encounter has one.
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    /** Where and how this contact happened. */
    type: {
        type: String,
        enum: ['home_visit', 'sub_centre', 'phc_opd', 'teleconsult', 'hospital', 'follow_up', 'lab_result', 'ai_generated_keywords'],
        default: 'teleconsult'
    },
    facilityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
    /**
     * Set only on a lab_result. Links the record back to the order it answers,
     * and makes writing a result twice detectable.
     */
    diagnosticRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiagnosticRequest', default: null },
    /** Who recorded it. A record with no attributable author is not a record. */
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorRole: { type: String, enum: ['doctor', 'health_worker', 'hospital', 'system'] },

    vitals: { type: vitalsSchema, default: undefined },
    /**
     * Danger signs found at this contact. Written by deterministic rules over
     * the vitals and the patient's context — never by a model, and never a
     * diagnosis. It records what was observed, not what it means.
     */
    dangerSigns: [{ type: String }],

    // Optional: a health worker observes and refers, they do not diagnose.
    diagnosis: { type: String },
    prescription: { type: String },
    notes: { type: String },

    /** AI-extracted keywords from completed patient consultation */
    keywords: [{ type: String }],
    isAiGenerated: { type: Boolean, default: false },

    /**
     * When the contact actually happened, which is not when the server heard
     * about it. A visit recorded in a village with no signal must keep its
     * real time once the phone syncs, or every later measure of delay is wrong.
     */
    occurredAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// The patient timeline query: everything for one person, newest first.
healthRecordSchema.index({ patientId: 1, occurredAt: -1 });

export default mongoose.model('HealthRecord', healthRecordSchema);

import { createReport } from '../lib/pdfReport.js';
import HealthRecord from '../models/HealthRecord.js';
import Appointment from '../models/Appointment.js';
import User from '../models/User.js';
import { notifyHealthRecordUploaded } from '../services/notifications/notificationService.js';
/**
 * Decides whether the caller may see this patient's records.
 *
 * Every endpoint below took patientId straight from the URL and trusted it,
 * so any signed-in account could download any patient's full medical history
 * by editing the address bar — the Content-Disposition header even named the
 * other patient in the filename.
 *
 * A patient sees their own records. A doctor sees a patient they have
 * actually treated, which is what writing the record required in the first
 * place. Nobody else.
 */
async function mayAccessPatient(user, patientId) {
    if (!user || !patientId) return false;
    if (String(user.id) === String(patientId)) return true;

    if (user.role === 'doctor') {
        const treated = await Appointment.exists({ doctorId: user.id, patientId });
        return Boolean(treated);
    }
    return false;
}

export const createRecord = async (req, res) => {
    try {
        const { patientId, appointmentId, diagnosis, prescription } = req.body;
        // A doctor writes records for their own patients, not for anyone.
        if (!await mayAccessPatient(req.user, patientId)) {
            return res.status(403).json({ message: 'You do not have access to this patient' });
        }
        const rec = await HealthRecord.create({ patientId, appointmentId, diagnosis, prescription });
        res.status(201).json(rec);

        // Fire-and-forget: let the patient know a new record was added to
        // their file. req.user is the doctor who is authoring it (route is
        // restricted to role 'doctor'); this only needs the patient's email.
        User.findById(patientId).select('name email').then(patient => {
            notifyHealthRecordUploaded({
                recipient: patient,
                uploadedBy: { name: req.user.name, role: 'doctor' },
                record: rec
            }).catch(() => {});
        }).catch(() => {});
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

export const getRecordsForPatient = async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!await mayAccessPatient(req.user, patientId)) {
            return res.status(403).json({ message: 'You do not have access to these records' });
        }
        const query = { patientId };
        if (req.user?.role !== 'doctor') {
            query.isAiGenerated = { $ne: true };
            query.type = { $ne: 'ai_generated_keywords' };
        }
        const records = await HealthRecord.find(query)
            .populate('appointmentId')
            .populate({
                path: 'appointmentId',
                populate: { path: 'doctorId', select: 'name specialization' }
            })
            // A visit recorded by a health worker has no appointment, so the
            // doctor on the appointment is not who saw the patient. Without
            // the author, every home visit would be shown as "unknown doctor".
            .populate('authorId', 'name role workerType specialization')
            .populate('facilityId', 'name level')
            .sort({ createdAt: -1 });
        res.json(records);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

export const downloadPatientHistoryPdf = async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!await mayAccessPatient(req.user, patientId)) {
            return res.status(403).json({ message: 'You do not have access to these records' });
        }
        const patient = await User.findById(patientId);
        if (!patient) return res.status(404).json({ message: 'Patient not found' });
        const pdfQuery = { patientId };
        if (req.user?.role !== 'doctor') {
            pdfQuery.isAiGenerated = { $ne: true };
            pdfQuery.type = { $ne: 'ai_generated_keywords' };
        }
        const records = await HealthRecord.find(pdfQuery)
            .populate('appointmentId')
            .populate({
                path: 'appointmentId',
                populate: { path: 'doctorId', select: 'name specialization' }
            })
            .sort({ createdAt: -1 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName(patient.name, 'health-records')}`);

        const doc = createReport({
            patient,
            records,
            title: 'Health Records',
            // Page numbering needs the total, which is only known at the end.
            single: false
        });
        doc.pipe(res);
        doc.end();
    } catch (e) {
        console.error('Error generating PDF:', e);
        res.status(500).json({ message: e.message });
    }
};

// Download individual health record as PDF
export const downloadIndividualRecordPdf = async (req, res) => {
    try {
        const { patientId, recordId } = req.params;
        if (!await mayAccessPatient(req.user, patientId)) {
            return res.status(403).json({ message: 'You do not have access to these records' });
        }
        const patient = await User.findById(patientId);
        if (!patient) return res.status(404).json({ message: 'Patient not found' });
        
        const record = await HealthRecord.findById(recordId)
            .populate('appointmentId')
            .populate({
                path: 'appointmentId',
                populate: { path: 'doctorId', select: 'name specialization' }
            });
            
        if (!record || record.patientId.toString() !== patientId) {
            return res.status(404).json({ message: 'Health record not found' });
        }
        if (req.user?.role !== 'doctor' && (record.isAiGenerated || record.type === 'ai_generated_keywords')) {
            return res.status(403).json({ message: 'You do not have access to this AI record' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName(patient.name, 'health-record')}`);

        const doc = createReport({ patient, records: [record], title: 'Health Record', single: true });
        doc.pipe(res);
        doc.end();
    } catch (e) {
        console.error('Error generating individual record PDF:', e);
        res.status(500).json({ message: e.message });
    }
};




/** A filename someone can find again in a crowded Downloads folder. */
function fileName(name, prefix) {
    const safe = String(name || 'patient').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patient';
    return `${prefix}-${safe}-${new Date().toISOString().split('T')[0]}.pdf`;
}

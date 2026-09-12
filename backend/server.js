import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import { attachSocketIO } from './middleware/socketMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import appointmentRoutes from './routes/appointmentRoutes.js';
import assistantRoutes from './routes/assistantRoutes.js';
import facilityRoutes from './routes/facilityRoutes.js';
import healthRecordRoutes from './routes/healthRecordRoutes.js';
import healthWorkerRoutes from './routes/healthWorkerRoutes.js';
import hospitalRoutes from './routes/hospitalRoutes.js';
import sessionRoutes from './routes/sessionRoutes.js';
import diagnosticRoutes from './routes/diagnosticRoutes.js';
import triageRoutes from './routes/triageRoutes.js';
import { startSessionScheduler } from './services/sessionScheduler.js';
import { timelineRouter, facilityRouter, medicineRouter } from './routes/insightsRoutes.js';
import pharmacyRoutes from './routes/pharmacyRoutes.js';
import recommendationRoutes from './routes/recommendationRoutes.js';
import referralRoutes from './routes/referralRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import { appendTranscriptChunk, finalizeConsultation, getLiveKeywords } from './services/liveConsultationManager.js';
import symptomCheckerRoutes from './routes/symptomCheckerRoutes.js';
import userRoutes from './routes/userRoutes.js';

dotenv.config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'http://localhost:3000',
    'https://sih-2026-roan.vercel.app'
];

const io = new SocketIOServer(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// DB
await connectDB();

// Middleware
app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));
app.use(morgan('dev'));

// Mounted before the global JSON parser: the assistant carries base64 photos
// and declares its own, larger body limit. Every other route keeps 100kb.
app.use('/api/assistant', assistantRoutes);

app.use(express.json());
app.use(attachSocketIO(io)); // Attach socket.io to requests

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/facilities', facilityRoutes);
app.use('/api/records', healthRecordRoutes);
app.use('/api/health-worker', healthWorkerRoutes);
app.use('/api/hospital', hospitalRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/diagnostics', diagnosticRoutes);
app.use('/api/triage', triageRoutes);
app.use('/api/patients', timelineRouter);
app.use('/api/facility', facilityRouter);
app.use('/api/medicines', medicineRouter);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/agent-recommendations', recommendationRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/symptom-checker', symptomCheckerRoutes);
app.use('/api/users', userRoutes);

// Simple health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Enhanced Socket.IO implementation
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Join user to their specific room for notifications
    socket.on('join-user-room', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined their room`);
    });
    
    // Join pharmacy to their specific room for orders
    socket.on('join-pharmacy-room', (pharmacyId) => {
        socket.join(`pharmacy_${pharmacyId}`);
        console.log(`Pharmacy ${pharmacyId} joined their room`);
    });
    
    // WebRTC signaling (video conferencing)
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        socket.to(roomId).emit('user-joined', socket.id);
        // Send existing live keywords if reconnected mid-call
        const currentKeywords = getLiveKeywords(roomId);
        if (currentKeywords.length > 0) {
            socket.emit('keywords-updated', { keywords: currentKeywords });
        }
    });

    socket.on('signal', ({ roomId, data }) => {
        socket.to(roomId).emit('signal', { from: socket.id, data });
    });

    // Real-time patient speech transcript stream (Client-side Web Speech STT)
    socket.on('transcript-chunk', ({ roomId, text }) => {
        appendTranscriptChunk(roomId, text, io);
    });

    // Handle call decline
    socket.on('call-declined', (roomId) => {
        socket.to(roomId).emit('call-declined');
    });

    // Handle call ending: broadcast call-ended & finalize/purge in-memory buffer
    socket.on('call-ended', (roomId) => {
        socket.to(roomId).emit('call-ended');
        finalizeConsultation(roomId).catch(err => {
            console.error('[server] Error finalizing live consultation:', err.message);
        });
    });
    
    // Real-time stock updates
    socket.on('subscribe-pharmacy-updates', (pharmacyId) => {
        socket.join(`pharmacy-updates-${pharmacyId}`);
        console.log(`Client subscribed to pharmacy ${pharmacyId} updates`);
    });
    
    socket.on('unsubscribe-pharmacy-updates', (pharmacyId) => {
        socket.leave(`pharmacy-updates-${pharmacyId}`);
        console.log(`Client unsubscribed from pharmacy ${pharmacyId} updates`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 5001;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}`);
    // Booking cutoffs finalise themselves; nobody presses a button.
    startSessionScheduler();
});



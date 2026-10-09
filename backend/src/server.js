require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { setSocketIo } = require('./utils/notify');

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/company');
const requirementsRoutes = require('./routes/requirements');
const quotationsRoutes = require('./routes/quotations');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const grnRoutes = require('./routes/grn');
const invoicesRoutes = require('./routes/invoices');
const adminRoutes = require('./routes/admin');
const vendorsRoutes = require('./routes/vendors');
const vendorCommunicationsRoutes = require('./routes/vendorCommunications');
const notificationsRoutes = require('./routes/notifications');
const internalRoutes = require('./routes/internal');
const quotationMessagesRoutes = require('./routes/quotationMessages');
const poMessagesRoutes = require('./routes/poMessages');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/requirements', requirementsRoutes);
app.use('/api/quotations', quotationsRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/grn', grnRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/vendor-communications', vendorCommunicationsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/quotation-messages', quotationMessagesRoutes);
app.use('/api/po-messages', poMessagesRoutes);

// --- Frontend, served from this same process/port --------------------------
// No build step: /frontend is plain HTML/CSS/JS, served directly.
// veridion/backend/src -> ../.. -> veridion -> frontend
const frontendRoot = path.resolve(__dirname, '..', '..', 'frontend');

if (!fs.existsSync(frontendRoot)) {
  console.warn(`WARNING: frontend folder not found at ${frontendRoot}`);
  console.warn('Expected layout: veridion/backend and veridion/frontend as siblings.');
} else {
  console.log(`Serving frontend from: ${frontendRoot}`);
}

// One static mount covering the whole frontend tree — it already serves
// /vendor/*, /company/*, /admin/*, /shared/*, /login.html, etc. because
// those are real subfolders/files inside frontendRoot.
app.use(express.static(frontendRoot));

app.get('/', (req, res) => res.sendFile(path.join(frontendRoot, 'index.html')));

// API 404s stay JSON (must be registered after the real /api routes above)
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// Anything else that isn't an API call and isn't a real static file falls
// back to login.html instead of a raw "Cannot GET" — convenient for typos.
app.use((req, res) => res.sendFile(path.join(frontendRoot, 'login.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Flow 6: Socket.io for real-time vendor notifications ------------------
// Socket.io needs the raw http.Server, so we create it explicitly instead of app.listen().
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten this to your actual frontend origin before any real deployment
});

// Authenticate the socket connection using the SAME JWT the user already has from a
// normal login (sent in the auth payload from the frontend). This keeps a vendor from
// being able to join another vendor's room by guessing an ID.
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Which private room this socket may join is decided ONLY by the verified token claims,
    // never by anything the client sends — so nobody can subscribe to another account's room.
    if (payload.role === 'vendor' && payload.vendor_id) {
      socket.room = `vendor_${payload.vendor_id}`;
    } else if (payload.role === 'platform_admin') {
      socket.room = 'platform_admin';
    } else if (['company_admin', 'procurement', 'finance', 'warehouse'].includes(payload.role) && payload.company_id) {
      socket.room = `company_${payload.company_id}_${payload.role}`;
    } else {
      return next(new Error('This account type has no notification room'));
    }
    next();
  } catch (err) {
    next(new Error('Invalid or missing token'));
  }
});

io.on('connection', (socket) => {
  socket.join(socket.room);
  console.log(`[socket] ${socket.room} connected`);
  socket.on('disconnect', () => {
    console.log(`[socket] ${socket.room} disconnected`);
  });
});

setSocketIo(io); // hands the io instance to notify.js so every route can use notifyVendor() / notifyCompanyRole() / notifyPlatformAdmins()

const PORT = process.env.PORT || 4000;
// listen on `server`, not `app`, so Socket.io's upgrade handling actually works
server.listen(PORT, () => console.log(`Veridion backend listening on http://localhost:${PORT}`));

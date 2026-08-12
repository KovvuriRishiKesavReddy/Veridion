require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/company');
const requirementsRoutes = require('./routes/requirements');
const quotationsRoutes = require('./routes/quotations');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const grnRoutes = require('./routes/grn');
const invoicesRoutes = require('./routes/invoices');

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

app.get('/', (req, res) => res.sendFile(path.join(frontendRoot, 'login.html')));

// API 404s stay JSON (must be registered after the real /api routes above)
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// Anything else that isn't an API call and isn't a real static file falls
// back to login.html instead of a raw "Cannot GET" — convenient for typos.
app.use((req, res) => res.sendFile(path.join(frontendRoot, 'login.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Veridion backend (Flow 1) listening on http://localhost:${PORT}`));

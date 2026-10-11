// File storage helper. In production (R2_* env vars set) files live in Cloudflare R2.
// In local dev (no R2_* vars) it falls back to the local uploads folder, so nothing
// about your existing local workflow changes.
//
// The string returned by uploadBuffer() is stored in the existing *_path columns
// (invoice_file_path, business_reg_proof_path, po_document_path, ...). Old rows that
// still hold an absolute local path keep working: downloadBuffer() reads those from disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const R2_ENABLED = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
const BUCKET = process.env.R2_BUCKET_NAME;
const LOCAL_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

const r2 = R2_ENABLED
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
    })
  : null;

// e.g. makeKey('invoices', 'scan.PDF') -> "invoices/1699999999999-ab12cd34.pdf"
function makeKey(prefix, originalName = '') {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${prefix}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

async function uploadBuffer(key, buffer, contentType) {
  if (R2_ENABLED) {
    await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  } else {
    const full = path.join(LOCAL_DIR, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
  }
  return key;
}

async function downloadBuffer(key) {
  // Legacy rows (and local eval scripts) store an absolute path — read straight from disk.
  if (path.isAbsolute(key) && fs.existsSync(key)) return fs.readFileSync(key);
  if (!R2_ENABLED) return fs.readFileSync(path.join(LOCAL_DIR, key));
  const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// Streams a stored file to an Express response. Auth checks stay in the route that calls this.
async function sendStoredFile(res, key) {
  try {
    const buffer = await downloadBuffer(key);
    res.set('Content-Type', TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    console.error('[storage] could not read', key, err.message);
    res.status(404).json({ error: 'File not found in storage' });
  }
}

module.exports = { uploadBuffer, downloadBuffer, makeKey, sendStoredFile, R2_ENABLED };

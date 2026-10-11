// File storage helper. In production files live in Supabase Storage (S3_* env vars) or Cloudflare R2 (R2_* vars).
// In local dev (no S3_*/R2_* vars) it falls back to the local uploads folder, so nothing
// about your existing local workflow changes.
//
// The string returned by uploadBuffer() is stored in the existing *_path columns
// (invoice_file_path, business_reg_proof_path, po_document_path, ...). Old rows that
// still hold an absolute local path keep working: downloadBuffer() reads those from disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

// Storage backend, chosen by environment variables:
//   1. S3_* vars set  -> any S3-compatible store (this is how Supabase Storage is used)
//   2. R2_* vars set  -> Cloudflare R2
//   3. neither        -> local uploads folder (local dev)
const S3_ENABLED = !!(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET);
const R2_ONLY = !S3_ENABLED && !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
const REMOTE_ENABLED = S3_ENABLED || R2_ONLY;
const R2_ENABLED = REMOTE_ENABLED; // kept for backwards-compatible exports
const BUCKET = S3_ENABLED ? process.env.S3_BUCKET : process.env.R2_BUCKET_NAME;
const LOCAL_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'backend', 'uploads');

function buildClient() {
  // Newer AWS SDK versions add extra checksum headers by default that some S3-compatible
  // stores reject; only send them when an operation strictly requires it.
  const common = { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' };
  if (S3_ENABLED) {
    return new S3Client({
      ...common,
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true, // Supabase needs path-style URLs: <endpoint>/<bucket>/<key>
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
    });
  }
  if (R2_ONLY) {
    return new S3Client({
      ...common,
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
    });
  }
  return null;
}
const r2 = buildClient(); // (name kept; it is the generic S3 client)

// e.g. makeKey('invoices', 'scan.PDF') -> "invoices/1699999999999-ab12cd34.pdf"
function makeKey(prefix, originalName = '') {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${prefix}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

async function uploadBuffer(key, buffer, contentType) {
  if (REMOTE_ENABLED) {
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
  if (!REMOTE_ENABLED) return fs.readFileSync(path.join(LOCAL_DIR, key));
  const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = { uploadBuffer, downloadBuffer, makeKey, R2_ENABLED };

const multer = require('multer');

// Files are held in memory (req.file.buffer) and the route handler uploads them to
// storage (Cloudflare R2 in production) itself — nothing is written to local disk, so
// Render's ephemeral filesystem can't lose anything.
module.exports = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

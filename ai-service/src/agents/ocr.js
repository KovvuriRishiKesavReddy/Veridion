// /ai-service/src/agents/ocr.js
//
// Agent 1: OCR & Structuring
// Handles THREE distinct input cases correctly:
//   1. Born-digital PDF (text layer already embedded, e.g. exported from accounting software)
//      -> extract text directly, no OCR needed, high confidence
//   2. Scanned PDF (photo of a paper invoice, saved as PDF, no text layer)
//      -> render each page to an image, run Tesseract on each page
//   3. Plain photo upload (jpg/png/webp/heic of a paper invoice)
//      -> run Tesseract directly on the image
//
// FIXED (this pass — two root-cause bugs that made OCR fail on real invoices):
//
// 1. PDF page rendering previously used node-canvas (native binding) + pdfjs-dist.
//    The canvas.node binary shipped in node_modules was compiled for Windows
//    (PE32+ DLL) and hard-crashes with "invalid ELF header" on any Linux host —
//    i.e. every scanned PDF (no embedded text layer) crashed OCR outright.
//    Rewritten to shell out to `pdftoppm` (poppler-utils) instead: no native
//    Node addon at all, just a system binary, which is far more portable across
//    dev machines / Docker / Render. Requires `poppler-utils` installed on the
//    host (`apt-get install -y poppler-utils`) — add this to the ai-service
//    Dockerfile in Flow 8.
//
// 2. Tesseract.js was called with no langPath/cachePath, so it always tried to
//    download eng.traineddata from cdn.jsdelivr.net at runtime, on every single
//    OCR call. Any restricted-egress environment (or a flaky network) made
//    every OCR call fail. Fixed by bundling the trained data file locally under
//    /ai-service/tessdata and pointing Tesseract at it directly — OCR now runs
//    fully offline, no network dependency at inference time.
//
// Also sets structuredData.__source so downstream agents (Agent 2 — Matching)
// can tell a real extraction apart from a total OCR failure — previously this
// flag was read in matching.js but never actually set here, so that check was
// permanently dead code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const pdfParseModule = require('pdf-parse');
// Different versions/builds of pdf-parse export differently:
// module.exports = fn  vs  module.exports = { default: fn }  vs  module.exports.pdf = fn
const pdfParse =
  typeof pdfParseModule === 'function'
    ? pdfParseModule
    : (pdfParseModule.default || pdfParseModule.pdf || pdfParseModule);
const { createWorker, PSM } = require('tesseract.js');
const { pool } = require('../db');
const { callGroqStructured } = require('../groqClient');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.heic']);
const MIN_EMBEDDED_TEXT_CHARS = 40; // below this, treat the PDF as scanned/image-only

// Local, bundled trained-data directory — see fix #2 above. Ships in the repo
// (ai-service/tessdata/eng.traineddata) so no network call is ever needed.
const TESSDATA_PATH = path.join(__dirname, '..', '..', 'tessdata');

// ---------- helpers ----------

function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  throw new Error(`Unsupported invoice file type: ${ext}`);
}

// FIXED: pdf-parse's default page renderer only inserts a newline when a text item's
// Y-position changes (new line) — it never inserts a SPACE between two text items on
// the same line, even when they're visibly separated (e.g. two adjacent table cells).
// PDF stores each positioned text run as a separate item with no literal space
// character between them; pdf.js/pdf-parse just concatenates item.str verbatim.
// Reproduced directly on a real invoice: a table row rendered as three separate
// items ("Cement", "100", "Rs. 100.00", "Rs. 10000.00") came out of the default
// renderer as "Cement100Rs.100.00Rs.10000.00" — all the right characters, but
// unparseable as separate fields once glued together, which is exactly what made
// line-item/quantity extraction fail even though embedded-text extraction "succeeded".
//
// This custom renderer inserts a space whenever the gap between where the previous
// item ended and the next one starts exceeds a small threshold. Verified against a
// real multi-column invoice table: every genuine word/cell boundary had a gap of 20+
// PDF units, comfortably above the threshold, with no small (sub-1-unit) gaps
// appearing within a single word — so this can't accidentally split a word apart,
// only join what should never have been glued together.
function renderPageWithSpacing(pageData) {
  const renderOptions = { normalizeWhitespace: false, disableCombineTextItems: false };
  return pageData.getTextContent(renderOptions).then((textContent) => {
    let lastY, lastEndX, text = '';
    for (const item of textContent.items) {
      const y = item.transform[5];
      const x = item.transform[4];
      if (lastY === y || lastY === undefined) {
        if (lastEndX !== undefined && x - lastEndX > 1) text += ' ';
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = y;
      lastEndX = x + (item.width || 0);
    }
    return text;
  });
}

async function extractEmbeddedPdfText(invoiceId, filePath) {
  if (typeof pdfParse !== 'function') {
    console.error('[ocr] pdf-parse did not resolve to a callable function — check `npm ls pdf-parse` and reinstall with `npm install pdf-parse@1.1.1 --save`');
    return ''; // fail soft into the Tesseract fallback path below, don't crash the pipeline
  }
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer, { pagerender: renderPageWithSpacing });
    return (data.text || '').trim();
  } catch (err) {
    // pdf-parse (via pdf.js) throws on real-world malformed PDFs — a broken/missing
    // cross-reference table ("bad XRef entry") is common from some scanners, phone
    // "print to PDF" tools, and third-party invoicing software that write technically
    // non-compliant PDFs. Previously this threw all the way out of processInvoiceOcr,
    // crashing the whole pipeline for that invoice — the consumer's nack(requeue=false)
    // then silently discarded the message forever, so the invoice just vanished with
    // no trace in the UI. Failing soft here instead lets renderPdfPagesToImages (which
    // uses poppler, a much more fault-tolerant PDF parser than pdf.js) have a real shot
    // at recovering the same file below.
    console.warn(`[ocr] invoice ${invoiceId}: embedded text extraction failed (${err.message}) — falling back to page-render + Tesseract`);
    return '';
  }
}

// Renders every page of a PDF to PNG files using `pdftoppm` (poppler-utils) —
// a system binary, not a native Node addon, so this works identically on any
// Linux host without needing a matching prebuilt binding. Only reached for
// scanned PDFs (no usable embedded text).
async function renderPdfPagesToImages(invoiceId, filePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veridion-ocr-'));
  const outPrefix = path.join(tmpDir, 'page');
  try {
    // -r 300: bumped from 200 DPI — see runTesseractOnBuffer below for why this
    // combined with an explicit page-segmentation mode was needed, not either alone.
    await execFileAsync('pdftoppm', ['-png', '-r', '300', filePath, outPrefix]);
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort(); // pdftoppm names pages page-1.png, page-2.png, ... — lexical sort is correct here
    if (files.length === 0) {
      console.warn(`[ocr] invoice ${invoiceId}: pdftoppm produced no output pages`);
      return [];
    }
    return files.map(f => fs.readFileSync(path.join(tmpDir, f)));
  } catch (err) {
    // poppler recovers from most malformed PDFs that break pdf.js (the embedded-text
    // path above), but a truly corrupt or non-PDF file can still fail here. Fail soft
    // rather than throw — the caller (runTesseractOnPdfPages) turns an empty page list
    // into rawText='', which the rest of the pipeline already handles correctly: low
    // confidence, falls back to vendor-submitted form fields, still reaches a decision
    // instead of crashing and silently disappearing.
    console.warn(`[ocr] invoice ${invoiceId}: pdftoppm failed to render this PDF (${err.message}) — treating as unreadable, zero text extracted`);
    return [];
  } finally {
    // Best-effort cleanup — never let a cleanup failure mask the real result/error.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// FIXED: previously used the Tesseract.recognize() shorthand at 200 DPI with no
// explicit page-segmentation mode. Reproduced against a real invoice with a bordered
// line-item table: the shorthand call silently garbled the entire item row into
// meaningless text ("Cement 100 Rs. 100.00 Rs. 10000.00" became "en yen ms") — Groq
// then correctly extracted an empty line_items array, because there was genuinely
// nothing usable in the text it was given. This wasn't a structuring/prompt bug
// downstream; the OCR step itself lost the table row before Groq ever saw it.
//
// Root cause was two things together, neither sufficient alone (verified by testing
// each in isolation): 200->300 DPI alone still garbled the row; the shorthand
// recognize() call with an explicit PSM passed inline silently ignored it entirely
// (four different PSM values all produced byte-identical output). The actual fix is
// the createWorker()+setParameters()+recognize() pattern with PSM.AUTO explicitly
// set, at 300 DPI — confirmed this correctly recovers the full table row (both the
// header "Description Qty Unit Price Amount" and the data row) at 94% confidence,
// up from 87%, on the exact invoice that failed.
async function runTesseractOnBuffer(buffer) {
  const worker = await createWorker('eng', 1, {
    langPath: TESSDATA_PATH,
    cachePath: TESSDATA_PATH,
    gzip: false, // the bundled eng.traineddata is already uncompressed
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const result = await worker.recognize(buffer);
    return {
      text: result.data.text || '',
      confidence: (result.data.confidence || 0) / 100, // Tesseract gives 0-100
    };
  } finally {
    await worker.terminate();
  }
}

async function runTesseractOnImageFile(filePath) {
  return runTesseractOnBuffer(fs.readFileSync(filePath));
}

async function runTesseractOnPdfPages(invoiceId, filePath) {
  const pageBuffers = await renderPdfPagesToImages(invoiceId, filePath);
  if (pageBuffers.length === 0) {
    return { text: '', confidence: 0 };
  }
  let combinedText = '';
  let confidenceSum = 0;

  for (const buf of pageBuffers) {
    const { text, confidence } = await runTesseractOnBuffer(buf);
    combinedText += text + '\n';
    confidenceSum += confidence;
  }

  return {
    text: combinedText.trim(),
    confidence: pageBuffers.length ? confidenceSum / pageBuffers.length : 0,
  };
}

// Counts how many of the expected invoice fields Groq actually filled in
// (i.e. not null / not empty string). This is the piece that was missing
// before — confidence was based only on OCR word-confidence, which is why
// a 0.85 score could coexist with an all-null structured_data object.
function computeFieldCompleteness(structuredData) {
  const expectedFields = [
    'vendor_name', 'invoice_number', 'invoice_date',
    'total_amount', 'gst_amount', 'gstin', 'quantity',
  ];
  const filled = expectedFields.filter(f => {
    const v = structuredData?.[f];
    return v !== null && v !== undefined && v !== '';
  });
  return filled.length / expectedFields.length;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    vendor_name: { type: ['string', 'null'] },
    invoice_number: { type: ['string', 'null'] },
    invoice_date: { type: ['string', 'null'] },
    total_amount: { type: ['number', 'null'] },
    gst_amount: { type: ['number', 'null'] },
    gstin: { type: ['string', 'null'] },
    quantity: { type: ['number', 'null'] },
    line_items: { type: 'array', items: { type: 'object' } },
    bank_account_number: { type: ['string', 'null'] },
  },
  required: ['vendor_name', 'invoice_number', 'total_amount'],
};

const SYSTEM_PROMPT = `You are an invoice data extraction engine. You will be given raw OCR text from an invoice, which may contain scanning noise, broken line breaks, or misread characters.

Extract exactly these fields as strict JSON matching the provided schema:
- vendor_name, invoice_number, invoice_date (ISO 8601 if possible), total_amount (number), gst_amount (number), gstin, quantity, line_items (array), bank_account_number (the seller's/vendor's own bank account number for receiving payment, if printed on the invoice — NOT the buyer's account, and NOT an IFSC code).

Rules:
- If a field genuinely cannot be found in the text, set it to null. Do NOT guess or fabricate a value.
- Do NOT explain your reasoning, output ONLY the JSON object.
- If the OCR text is empty or unreadable, return all fields as null rather than refusing.`;

// ---------- main entrypoint ----------

// Looks up the invoice's stored file path from the database.
// invoices.invoice_file_path is set at upload time (Prompt 1.5 — POST /api/invoices).
async function getInvoiceFilePath(invoiceId) {
  const { rows } = await pool.query(
    `SELECT invoice_file_path FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  if (rows.length === 0) {
    throw new Error(`No invoice found with id ${invoiceId}`);
  }
  const filePath = rows[0].invoice_file_path;
  if (!filePath) {
    throw new Error(`Invoice ${invoiceId} has no invoice_file_path set`);
  }
  return filePath;
}

// Accepts EITHER just an invoiceId (looks up the file path itself, this is
// what server.js's runOcrAgent(invoiceId) calls expect) OR (invoiceId, filePath)
// if the caller already has the path and wants to skip the extra DB lookup.
async function processInvoiceOcr(invoiceId, filePath) {
  if (!filePath) {
    filePath = await getInvoiceFilePath(invoiceId);
  }

  const fileType = detectFileType(filePath);

  let rawText = '';
  let ocrConfidence = 1.0; // born-digital text extraction is essentially ground truth
  let extractionMethod = '';

  if (fileType === 'pdf') {
    const embeddedText = await extractEmbeddedPdfText(invoiceId, filePath);

    if (embeddedText.length >= MIN_EMBEDDED_TEXT_CHARS) {
      rawText = embeddedText;
      ocrConfidence = 1.0;
      extractionMethod = 'pdf_embedded_text';
    } else {
      console.log(`[ocr] invoice ${invoiceId}: no usable embedded text, falling back to page-render + Tesseract`);
      const result = await runTesseractOnPdfPages(invoiceId, filePath);
      rawText = result.text;
      ocrConfidence = result.confidence;
      extractionMethod = rawText ? 'pdf_rendered_tesseract' : 'pdf_unreadable';
    }
  } else {
    // photo of a document — jpg/png/etc.
    const result = await runTesseractOnImageFile(filePath);
    rawText = result.text;
    ocrConfidence = result.confidence;
    extractionMethod = 'image_tesseract';
  }

  console.log(`[ocr] invoice ${invoiceId}: extraction method=${extractionMethod}, raw text length=${rawText.length}, ocrConfidence=${ocrConfidence.toFixed(2)}`);

  if (!rawText || rawText.trim().length === 0) {
    console.warn(`[ocr] invoice ${invoiceId}: WARNING — extracted zero characters of text. Structuring will be skipped.`);
  }

  // ---- structuring via Groq ----
  // __source tags whether this structured_data reflects a real read of the
  // uploaded document or not — Agent 2 (Matching) relies on this to decide
  // whether its form-vs-document self-consistency check is meaningful at all
  // (comparing vendor-submitted form fields against a "document" that was
  // never actually read would always trivially match and prove nothing).
  // Previously this field was checked in matching.js but never set here, so
  // that check silently always ran, even after a total OCR failure.
  let structuredData = {
    vendor_name: null, invoice_number: null, invoice_date: null,
    total_amount: null, gst_amount: null, gstin: null,
    quantity: null, line_items: [], bank_account_number: null,
    __source: 'vendor_submitted_fallback',
  };

  if (rawText.trim().length > 0) {
    try {
      const groqResult = await callGroqStructured(SYSTEM_PROMPT, rawText, EXTRACTION_SCHEMA);
      console.log(`[ocr] invoice ${invoiceId}: raw Groq structuring response:`, JSON.stringify(groqResult));
      structuredData = { ...structuredData, ...groqResult, __source: 'ocr_extraction' };
    } catch (err) {
      // IMPORTANT: log loudly instead of silently falling through to all-nulls.
      // Previously a parse failure here was indistinguishable from "nothing found".
      console.error(`[ocr] invoice ${invoiceId}: Groq structuring FAILED — ${err.message}`);
      console.error(`[ocr] invoice ${invoiceId}: raw text that was sent to Groq (first 500 chars): ${rawText.slice(0, 500)}`);
      // structuredData stays __source: 'vendor_submitted_fallback' — Groq never
      // successfully told us what's really in the document.
    }
  }

  const fieldCompleteness = computeFieldCompleteness(structuredData);

  // Final confidence blends how legible the source was with how much
  // Groq was actually able to pull out of it. A method with perfect OCR
  // confidence but zero fields filled in should NOT read as high confidence.
  const confidenceScore = Number((ocrConfidence * 0.4 + fieldCompleteness * 0.6).toFixed(2));

  await pool.query(
    `INSERT INTO document_extractions
      (invoice_id, raw_ocr_text, structured_data, confidence_score, bounding_boxes)
     VALUES ($1, $2, $3, $4, $5)`,
    [invoiceId, rawText, structuredData, confidenceScore, JSON.stringify([])]
  );

  console.log(`[ocr] invoice ${invoiceId}: DONE — method=${extractionMethod}, fieldCompleteness=${fieldCompleteness.toFixed(2)}, finalConfidence=${confidenceScore}`);

  return { rawText, structuredData, confidenceScore, extractionMethod };
}

module.exports = {
  processInvoiceOcr,
  runOcrAgent: processInvoiceOcr, // alias — keeps existing pipeline callers working
};
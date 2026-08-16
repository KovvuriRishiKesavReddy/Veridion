const fs = require('fs');
const path = require('path');
const db = require('../db');
const { callGroqStructured } = require('../groqClient');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const PDF_EXTENSIONS = ['.pdf'];

// runOcrAgent: Agent 1 — OCR + Structuring.
// Now handles BOTH real PDF text extraction (pdf-parse, since most real invoices are
// PDFs, not scanned images) and image OCR (tesseract.js). Since invoice upload is now
// mandatory (Flow 2 change), this is the primary path, not a rare edge case — the
// fallback to vendor-submitted fields only fires if extraction genuinely fails (a
// corrupted file, an image-only PDF tesseract can't help with, etc.), and stays
// clearly marked with a lower confidence score when it does.
async function runOcrAgent(invoiceId) {
  const invRes = await db.query(
    `SELECT inv.*, v.company_name as vendor_name, po.agreed_price, po.agreed_quantity
     FROM invoices inv
     JOIN vendors v ON v.id = inv.vendor_id
     JOIN purchase_orders po ON po.id = inv.po_id
     WHERE inv.id = $1`,
    [invoiceId]
  );
  const invoice = invRes.rows[0];
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  let rawOcrText = null;
  let ocrSucceeded = false;
  const ext = invoice.invoice_file_path ? path.extname(invoice.invoice_file_path).toLowerCase() : null;

  if (invoice.invoice_file_path && PDF_EXTENSIONS.includes(ext)) {
    try {
      rawOcrText = await extractPdfText(invoice.invoice_file_path);
      ocrSucceeded = rawOcrText && rawOcrText.trim().length > 0;
      if (!ocrSucceeded) {
        console.warn(`[Agent 1] PDF for invoice ${invoiceId} produced no extractable text — likely a scanned/image-only PDF, not real text. Falling back.`);
      }
    } catch (err) {
      console.warn(`[Agent 1] PDF text extraction failed for invoice ${invoiceId}, falling back to submitted fields:`, err.message);
    }
  } else if (invoice.invoice_file_path && IMAGE_EXTENSIONS.includes(ext)) {
    try {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng');
      const { data } = await worker.recognize(invoice.invoice_file_path);
      await worker.terminate();
      rawOcrText = data.text;
      ocrSucceeded = rawOcrText && rawOcrText.trim().length > 0;
    } catch (err) {
      console.warn(`[Agent 1] Tesseract OCR failed for invoice ${invoiceId}, falling back to submitted fields:`, err.message);
    }
  }

  let structuredData;
  let confidenceScore;

  if (ocrSucceeded) {
    const systemPrompt = `You extract structured invoice data from raw invoice text. Respond ONLY with a JSON object with keys: vendor_name, invoice_number, total_amount, gst_amount, gstin, invoice_date, quantity. Use null for any field you cannot find. Extract numbers as plain numbers (no currency symbols or commas). GSTIN should be exactly as printed, 15 characters, no spaces.`;
    const groqResult = await callGroqStructured(systemPrompt, rawOcrText);
    if (groqResult.__stub) {
      // Real document text exists but no Groq key to structure it — do a basic regex
      // pass instead of losing the extraction entirely.
      structuredData = regexExtract(rawOcrText, invoice);
      confidenceScore = 0.65; // real document text, weaker structuring
    } else {
      structuredData = groqResult;
      confidenceScore = 0.85; // real document + real LLM structuring
    }
  } else {
    rawOcrText = rawOcrText || `[No extractable text from the uploaded document — structured from vendor-submitted invoice fields for invoice #${invoice.id}]`;
    structuredData = fallbackStructuredData(invoice);
    confidenceScore = 0.5; // self-reported, not independently verified — deliberately capped
  }

  const result = await db.query(
    `INSERT INTO document_extractions (invoice_id, raw_ocr_text, structured_data, confidence_score, bounding_boxes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [invoiceId, rawOcrText, JSON.stringify(structuredData), confidenceScore, JSON.stringify([])]
  );
  return result.rows[0];
}

// regexExtract: a basic fallback structurer for when real document text was extracted
// but no Groq key is configured to do the structuring — finds a GSTIN-shaped string
// and the largest currency-looking number as a rough total. Deliberately simple; the
// LLM path is what does this properly.
function regexExtract(text, invoice) {
  const gstinMatch = text.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}/);
  const amounts = [...text.matchAll(/[\d,]+\.?\d*/g)].map(m => parseFloat(m[0].replace(/,/g, ''))).filter(n => !isNaN(n));
  return {
    vendor_name: invoice.vendor_name,
    invoice_number: invoice.invoice_number,
    total_amount: amounts.length ? Math.max(...amounts) : invoice.invoice_amount,
    gst_amount: invoice.gst_amount,
    gstin: gstinMatch ? gstinMatch[0] : null,
    invoice_date: null,
    quantity: invoice.invoice_quantity,
    __source: 'regex_extraction_no_groq_key'
  };
}

// extractPdfText: uses pdfjs-dist (Mozilla's actively-maintained PDF.js) rather than
// the older 'pdf-parse' package — testing found pdf-parse bundles a very outdated
// pdf.js (v1.10.100, ~2017) that fails on valid, well-formed PDFs from modern
// generators like pdfkit ("bad XRef entry" on a structurally correct file). pdfjs-dist
// handles the same file correctly.
async function extractPdfText(filePath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(' ') + '\n';
  }
  return fullText;
}

function fallbackStructuredData(invoice) {
  return {
    vendor_name: invoice.vendor_name,
    invoice_number: invoice.invoice_number,
    total_amount: invoice.invoice_amount,
    gst_amount: invoice.gst_amount,
    gstin: invoice.gstin_on_invoice,
    invoice_date: null,
    quantity: invoice.invoice_quantity,
    __source: 'vendor_submitted_fallback'
  };
}

module.exports = { runOcrAgent };

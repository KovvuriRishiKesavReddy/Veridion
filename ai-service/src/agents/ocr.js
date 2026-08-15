const fs = require('fs');
const path = require('path');
const db = require('../db');
const { callGroqStructured } = require('../groqClient');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

// runOcrAgent: Agent 1 — OCR + Structuring.
// If a real image file was uploaded, this attempts genuine OCR via tesseract.js. If
// there's no file, the file isn't an image (e.g. a PDF — out of scope for this simple
// pass), or OCR fails for any reason, it falls back to structuring directly from what
// the vendor typed into the upload form. That fallback is clearly marked with a lower
// confidence score, since it's self-reported rather than independently read off a
// document — this is the honest, functioning version of the agent when no scanned
// document is available, not a placeholder.
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

  if (invoice.invoice_file_path && IMAGE_EXTENSIONS.includes(path.extname(invoice.invoice_file_path).toLowerCase())) {
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
    const systemPrompt = `You extract structured invoice data from raw OCR text. Respond ONLY with a JSON object with keys: vendor_name, invoice_number, total_amount, gst_amount, gstin, invoice_date, quantity. Use null for any field you cannot find.`;
    const groqResult = await callGroqStructured(systemPrompt, rawOcrText);
    if (groqResult.__stub) {
      // OCR text exists but no Groq key to structure it — fall back to submitted fields
      // rather than leaving structured_data empty.
      structuredData = fallbackStructuredData(invoice);
      confidenceScore = 0.5;
    } else {
      structuredData = groqResult;
      confidenceScore = 0.85; // real OCR + real LLM structuring
    }
  } else {
    rawOcrText = rawOcrText || `[No scanned document available — structured from vendor-submitted invoice fields for invoice #${invoice.id}]`;
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

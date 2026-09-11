require('dotenv').config();
const express = require('express');
const amqp = require('amqplib');

// Safety net: tesseract.js's worker (used for image OCR and the scanned-PDF fallback)
// can, on a network failure fetching its language data, throw in a way that escapes
// the normal try/catch around it (an internal worker_threads error event with no
// listener, which Node re-throws via process.nextTick and treats as fatal by default).
// Confirmed this during testing: a blocked language-data download crashed the entire
// service, not just that one invoice — meaning every other invoice stops processing
// until someone manually restarts it. This must never happen for a transient network
// issue. Logging and continuing here is the correct behavior for a long-running
// service; the specific invoice that triggered it still falls back to
// vendor-submitted fields via the try/catch inside runOcrAgent itself.
process.on('uncaughtException', (err) => {
  console.error('[FATAL-CAUGHT] Uncaught exception — service continues running:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL-CAUGHT] Unhandled promise rejection — service continues running:', err?.message || err);
});

const db = require('./db');
const { runOcrAgent } = require('./agents/ocr');
const { runMatchingAgent } = require('./agents/matching');
const { runComplianceAgent } = require('./agents/compliance');
const { runDecisionAgent } = require('./agents/decide');
const { runFraudAgent } = require('./agents/fraud');
const { onGrnConfirmed, onDisputeResolved, onInvoiceDecisionFinalised } = require('./agents/vendorRisk');
const { runRankQuotationsAgent } = require('./agents/rankQuotations');
const { runVendorCommunicationAgent } = require('./agents/vendorCommunication');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', groq_configured: !!process.env.GROQ_API_KEY, neo4j_configured: !!process.env.NEO4J_URI }));

// Each agent is exposed as its own route too — lets you test/re-run a single stage
// directly (e.g. curl POST /agents/decide) without needing a queue message, which is
// exactly how these were verified during development.
app.post('/agents/ocr', async (req, res) => {
  try {
    const result = await runOcrAgent(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/agents/matching', async (req, res) => {
  try {
    const result = await runMatchingAgent(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/agents/compliance', async (req, res) => {
  try {
    const result = await runComplianceAgent(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/agents/decide', async (req, res) => {
  try {
    const result = await runDecisionAgent(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/agents/fraud', async (req, res) => {
  try {
    const result = await runFraudAgent(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /agents/vendor-risk/on-grn-confirmed — called by the backend's GRN route the
// moment a delivery is recorded.
app.post('/agents/vendor-risk/on-grn-confirmed', async (req, res) => {
  try {
    const result = await onGrnConfirmed(req.body.po_id, req.body.grn_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /agents/vendor-risk/on-dispute-resolved — wired up in Flow 4: the backend's
// vendor-communications resolve route calls this the moment Finance marks a dispute
// resolved.
app.post('/agents/vendor-risk/on-dispute-resolved', async (req, res) => {
  try {
    const result = await onDisputeResolved(req.body.company_id, req.body.vendor_id, req.body.was_disputed);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /agents/vendor-risk/on-decision-overridden — wired up from the backend's
// override-and-pay route. Closes a real gap: a flagged invoice's decision registers as
// a "bad" (0) event in the vendor's running invoice_accuracy_pct the moment Agent 8
// decides -- BEFORE any human ever reviews it. If Finance later determines the flag
// was wrong and overrides to pay it, that permanent black mark used to stand forever,
// even though a human explicitly confirmed the invoice was actually fine -- making it
// structurally harder for a vendor to ever recover from an early run of (possibly
// unwarranted) flags, since every corrected invoice still counted against them.
//
// This reuses the EXACT SAME running-average update (onInvoiceDecisionFinalised) Agent
// 5 already uses for a real decision -- called with 'auto_approved', since an override
// is Finance affirmatively saying "this was fine." It does not retroactively edit the
// original bad event (the running average only stores an aggregate, not individual
// event history, so there's nothing to edit) -- it registers ONE NEW corrective event
// instead. The honest trade-off: this invoice ends up counted twice in data_volume
// (once flagged, once corrected) rather than once -- but leaving a corrected invoice
// permanently dragging the score down forever is clearly the worse trade-off. The
// backend's override-and-pay route can only ever call this once per invoice (its own
// idempotency guard is that overriding an already-paid invoice is rejected outright),
// so this never repeats for the same invoice.
app.post('/agents/vendor-risk/on-decision-overridden', async (req, res) => {
  try {
    const result = await onInvoiceDecisionFinalised(req.body.invoice_id, 'auto_approved');
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /agents/rank-quotations — Agent 6. Body: { requirement_id }. Ranks every
// quotation on that requirement via the Context Gate (Price + Delivery + Past
// Performance) and writes ai_rank_score/ai_rank_reasoning back onto each quotations
// row. Called by the backend's GET /api/requirements/:id/quotations route.
app.post('/agents/rank-quotations', async (req, res) => {
  try {
    const result = await runRankQuotationsAgent(req.body.requirement_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /agents/draft-dispute — Agent 7, exposed directly for manual/testing use.
// In normal operation this is called automatically from inside Agent 8 (decide.js)
// whenever a decision comes back 'flagged'.
app.post('/agents/draft-dispute', async (req, res) => {
  try {
    const result = await runVendorCommunicationAgent(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The full pipeline in sequence: OCR -> Matching + Compliance (run concurrently, since
// neither depends on the other's result) -> Decision Engine. This is the same logic the
// RabbitMQ consumer below runs automatically for every submitted invoice.
async function runFullPipeline(invoiceId) {
  console.log(`[pipeline] invoice ${invoiceId}: starting OCR`);
  await runOcrAgent(invoiceId);

  console.log(`[pipeline] invoice ${invoiceId}: running Matching + Compliance concurrently`);
  await Promise.all([runMatchingAgent(invoiceId), runComplianceAgent(invoiceId)]);

  console.log(`[pipeline] invoice ${invoiceId}: running Decision Engine (Context Gate — now includes Fraud + Vendor Risk)`);
  const decision = await runDecisionAgent(invoiceId);

  console.log(`[pipeline] invoice ${invoiceId}: DONE — ${decision.final_decision} (score ${Number(decision.final_score).toFixed(2)})`);
  return decision;
}

// Safety net for the RabbitMQ consumer only (not the direct /agents/run-pipeline route,
// where a caller wants the real error back to debug against). Previously, if ANYTHING
// in the pipeline threw for any reason — a malformed PDF pdf-parse couldn't handle, a
// transient DB hiccup, a future bug in any agent — the consumer caught it, logged one
// line, and called nack(msg, false, false), which discards the message permanently with
// no requeue. The invoice then just sat at status='submitted' forever with zero trace
// anywhere in the UI that anything had gone wrong. Confirmed this directly: a PDF with a
// broken cross-reference table threw "bad XRef entry" out of pdf-parse and the invoice
// vanished with only a server console line to show for it.
//
// This wrapper guarantees every invoice that reaches the queue ends up in a
// human-visible state — either a real decision, or a 'flagged' row explaining that
// processing itself failed (distinct reasoning text from a normal mismatch flag) so
// Finance sees it in the same review queue they already check, and knows to have it
// reprocessed rather than mistaking silence for "nothing to review".
async function runFullPipelineWithSafetyNet(invoiceId) {
  try {
    return await runFullPipeline(invoiceId);
  } catch (err) {
    console.error(`[pipeline] invoice ${invoiceId}: FAILED — ${err.message}. Writing a flagged fallback decision instead of dropping the invoice silently.`);
    try {
      await db.query(
        `INSERT INTO decisions (invoice_id, agent_inputs, gate_weights, final_score, final_decision, reasoning_text)
         VALUES ($1, $2, $3, 0, 'flagged', $4)`,
        [
          invoiceId,
          JSON.stringify({ processing_error: err.message }),
          JSON.stringify({}),
          `Automated processing could not complete for this invoice (${err.message}). ` +
            `This is a pipeline/technical failure, not a normal mismatch finding — the ` +
            `document may be corrupted or in an unsupported format. Please have it ` +
            `re-uploaded or reprocessed rather than treating this as a business decision.`,
        ]
      );
      await db.query(`UPDATE invoices SET status = 'flagged' WHERE id = $1`, [invoiceId]);
    } catch (innerErr) {
      // If even the safety net fails (e.g. DB is genuinely down), there is nothing more
      // we can do here — log loudly so it's visible, and let the caller's catch handle it.
      console.error(`[pipeline] invoice ${invoiceId}: safety-net write ALSO failed — ${innerErr.message}`);
    }
    throw err; // still propagate — the consumer needs this to decide ack/nack correctly
  }
}

app.post('/agents/run-pipeline', async (req, res) => {
  try {
    const result = await runFullPipeline(req.body.invoice_id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// RabbitMQ consumer — this is what actually makes the pipeline automatic. The backend
// publishes { invoice_id } to 'invoice.submitted' the moment a vendor uploads an
// invoice; this consumer picks it up and runs the full pipeline with no manual trigger.
async function startConsumer() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
    const channel = await conn.createChannel();
    await channel.assertQueue('invoice.submitted', { durable: true });
    channel.prefetch(1); // one invoice at a time — simple and predictable for now

    console.log('RabbitMQ consumer listening on queue: invoice.submitted');

    channel.consume('invoice.submitted', async (msg) => {
      if (!msg) return;
      try {
        const { invoice_id } = JSON.parse(msg.content.toString());
        console.log(`[consumer] received invoice.submitted for invoice ${invoice_id}`);
        await runFullPipelineWithSafetyNet(invoice_id);
        channel.ack(msg);
      } catch (err) {
        console.error('[consumer] pipeline failed for message:', err.message);
        // Reject without requeue — a permanently broken message (e.g. bad invoice_id)
        // would otherwise loop forever. A real system would dead-letter this instead.
        channel.nack(msg, false, false);
      }
    });

    conn.on('close', () => {
      console.warn('RabbitMQ connection closed — retrying in 5s');
      setTimeout(startConsumer, 5000);
    });
  } catch (err) {
    console.error('Could not connect to RabbitMQ, retrying in 5s:', err.message);
    setTimeout(startConsumer, 5000);
  }
}

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Veridion AI service listening on http://localhost:${PORT}`);
  console.log(`Groq API key configured: ${!!process.env.GROQ_API_KEY}`);
  startConsumer();
});

require('dotenv').config();
const express = require('express');
const amqp = require('amqplib');

const { runOcrAgent } = require('./agents/ocr');
const { runMatchingAgent } = require('./agents/matching');
const { runComplianceAgent } = require('./agents/compliance');
const { runDecisionAgent } = require('./agents/decide');
const { runFraudAgent } = require('./agents/fraud');
const { onGrnConfirmed, onDisputeResolved } = require('./agents/vendorRisk');

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

// POST /agents/vendor-risk/on-dispute-resolved — not called by anything yet (the
// dispute flow is Flow 4), exposed now so Flow 4 can wire it directly.
app.post('/agents/vendor-risk/on-dispute-resolved', async (req, res) => {
  try {
    const result = await onDisputeResolved(req.body.company_id, req.body.vendor_id, req.body.was_disputed);
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
        await runFullPipeline(invoice_id);
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

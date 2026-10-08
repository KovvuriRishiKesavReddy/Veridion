const amqp = require('amqplib');

// INVOICE_QUEUE lets the isolated test mode (scripts/with-test-db.js) use its own queue, so a
// test run can never leave messages behind that a normal ai-service would later consume.
const QUEUE = process.env.INVOICE_QUEUE || 'invoice.submitted';

let channel = null;
let connecting = null;

async function getChannel() {
  if (channel) return channel;
  if (connecting) return connecting; // avoid racing multiple simultaneous connects

  connecting = (async () => {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
    const ch = await conn.createChannel();
    await ch.assertQueue(QUEUE, { durable: true });
    conn.on('error', (err) => { console.error('RabbitMQ connection error:', err.message); channel = null; });
    conn.on('close', () => { console.warn('RabbitMQ connection closed'); channel = null; });
    channel = ch;
    return ch;
  })();

  return connecting;
}

// publishInvoiceSubmitted: fire-and-forget by design. If RabbitMQ is down or
// unreachable, this must NEVER block or fail the invoice upload itself — the
// invoice is already safely in Postgres; the AI pipeline picking it up is a
// separate concern. Errors are logged, not thrown.
async function publishInvoiceSubmitted(invoiceId) {
  try {
    const ch = await getChannel();
    ch.sendToQueue(QUEUE, Buffer.from(JSON.stringify({ invoice_id: invoiceId })), { persistent: true });
  } catch (err) {
    console.error(`Could not publish invoice.submitted for invoice ${invoiceId} (invoice upload still succeeded):`, err.message);
  }
}

module.exports = { publishInvoiceSubmitted };

const neo4j = require('neo4j-driver');

let driver = null;
let warned = false;

function getDriver() {
  if (driver) return driver;
  if (!process.env.NEO4J_URI) return null;
  driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || '')
  );
  return driver;
}

// runWrite: fire-and-forget, exactly like the RabbitMQ publisher (utils/queue.js) — a
// vendor registration or PO/invoice creation must NEVER fail or slow down because the
// graph sync had trouble. Errors are logged once, not thrown.
async function runWrite(query, params) {
  const d = getDriver();
  if (!d) {
    if (!warned) {
      console.warn('[Neo4j sync] NEO4J_URI not configured — graph sync skipped (harmless; Fraud Detection will just have no data to check until Neo4j is set up).');
      warned = true;
    }
    return;
  }
  const session = d.session();
  try {
    await session.run(query, params);
  } catch (err) {
    console.error('[Neo4j sync] write failed (non-fatal):', err.message);
  } finally {
    await session.close();
  }
}

// Keeps the graph's Vendor/BankAccount/Address nodes in sync — this is what powers
// shell-company detection (SHARES_BANK_ACCOUNT_WITH / SHARES_ADDRESS_WITH) in Agent 4.
async function syncVendorNode(vendor) {
  await runWrite(
    `MERGE (v:Vendor {id: $id})
     SET v.company_name = $company_name, v.gstin = $gstin
     WITH v
     FOREACH (_ IN CASE WHEN $bank_account_number IS NOT NULL THEN [1] ELSE [] END |
       MERGE (b:BankAccount {number: $bank_account_number})
       MERGE (v)-[:HAS_BANK_ACCOUNT]->(b)
     )
     FOREACH (_ IN CASE WHEN $address IS NOT NULL THEN [1] ELSE [] END |
       MERGE (a:Address {value: $address})
       MERGE (v)-[:HAS_ADDRESS]->(a)
     )`,
    {
      id: vendor.id, company_name: vendor.company_name, gstin: vendor.gstin || null,
      bank_account_number: vendor.bank_account_number || null, address: vendor.address || null
    }
  );
}

async function syncPurchaseOrderNode(po) {
  await runWrite(
    `MATCH (v:Vendor {id: $vendor_id})
     MERGE (po:PurchaseOrder {id: $id})
     SET po.agreed_price = $agreed_price, po.agreed_quantity = $agreed_quantity, po.company_id = $company_id
     MERGE (v)-[:SUPPLIED_TO]->(po)`,
    { id: po.id, vendor_id: po.vendor_id, agreed_price: Number(po.agreed_price), agreed_quantity: Number(po.agreed_quantity), company_id: po.company_id }
  );
}

async function syncInvoiceNode(invoice) {
  await runWrite(
    `MATCH (po:PurchaseOrder {id: $po_id})
     MERGE (inv:Invoice {id: $id})
     SET inv.amount = $amount, inv.submitted_at = $submitted_at
     MERGE (inv)-[:AGAINST]->(po)`,
    { id: invoice.id, po_id: invoice.po_id, amount: Number(invoice.invoice_amount), submitted_at: new Date(invoice.submitted_at).toISOString() }
  );
}

module.exports = { syncVendorNode, syncPurchaseOrderNode, syncInvoiceNode };

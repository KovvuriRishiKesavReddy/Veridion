const PDFDocument = require('pdfkit');
const { uploadBuffer } = require('./storage');

// Builds the PO PDF in memory, uploads it to storage, and resolves with the storage key
// (stored in purchase_orders.po_document_path).
function generatePoPdf(po, requirement, vendor, company) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', async () => {
      try {
        const key = `pos/po-${po.id}.pdf`;
        await uploadBuffer(key, Buffer.concat(chunks), 'application/pdf');
        resolve(key);
      } catch (err) { reject(err); }
    });
    doc.on('error', reject);

    doc.fontSize(20).text('Purchase Order', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`PO #${po.id}`, { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(12).text(`Issued by: ${company.name}`);
    doc.text(`GSTIN: ${company.gstin || 'N/A'}`);
    doc.text(`Address: ${company.address || 'N/A'}`);
    doc.moveDown();

    doc.text(`Vendor: ${vendor.company_name}`);
    doc.text(`Vendor GSTIN: ${vendor.gstin || 'N/A'}`);
    doc.moveDown();

    doc.text(`Requirement: ${requirement.title}`);
    doc.text(`Category: ${requirement.category || 'N/A'}`);
    doc.moveDown();

    doc.fontSize(14).text('Order Details', { underline: true });
    doc.fontSize(12);
    doc.text(`Agreed Price: ${po.agreed_price}`);
    doc.text(`Agreed Quantity: ${po.agreed_quantity}`);
    doc.text(`Agreed Delivery Date: ${po.agreed_delivery_date || 'TBD'}`);
    doc.moveDown(2);

    doc.fontSize(10).fillColor('gray').text(`Generated automatically by Veridion on ${new Date().toISOString()}`);

    doc.end();
  });
}

module.exports = { generatePoPdf };

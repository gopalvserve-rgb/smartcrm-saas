/**
 * QUOTE_PDF_v1 (2026-05-26) — render a quotation row + items as a PDF
 * stream using pdfkit (pure Node, no Chrome dependency).
 *
 * Usage:
 *   const stream = renderQuotationPdf({ quotation, items, brand });
 *   stream.pipe(res);
 *
 * Layout: A4 portrait, company header strip (logo + name + GST + contact),
 * customer block, line-items table, totals block, notes/T&C footer.
 */

const PDFDocument = require('pdfkit');

function _money(amt, currency = 'INR') {
  const sym = currency === 'INR' ? 'Rs.' : currency === 'USD' ? '$' : currency + ' ';
  const n = Number(amt) || 0;
  return sym + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _formatDate(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (_) { return String(s); }
}

/**
 * Returns a PDFDocument stream. Caller should .pipe() it to a writable.
 */
function renderQuotationPdf({ quotation: q, items, brand }) {
  brand = brand || {};
  items = items || [];
  const cur = q.currency || 'INR';
  const company = brand.COMPANY_NAME || 'SmartCRM';

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {
      Title: 'Quotation ' + (q.number || ''),
      Author: company,
      Subject: 'Quotation for ' + (q.customer_name || 'Customer')
    }
  });

  // ─── HEADER STRIP ─────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 90).fill('#4F46E5');     // SmartCRM indigo bar
  doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold')
     .text(company, 40, 28, { width: doc.page.width - 80 });

  if (brand.COMPANY_ADDRESS || brand.COMPANY_PHONE || brand.COMPANY_GST) {
    const sub = [
      brand.COMPANY_ADDRESS,
      brand.COMPANY_PHONE ? 'Ph: ' + brand.COMPANY_PHONE : '',
      brand.COMPANY_GST ? 'GST: ' + brand.COMPANY_GST : ''
    ].filter(Boolean).join('  •  ');
    doc.fontSize(9).font('Helvetica').fillColor('#E0E7FF')
       .text(sub, 40, 60, { width: doc.page.width - 80 });
  }

  // ─── QUOTE NUMBER + DATES ─────────────────────────────────────
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(16)
     .text('QUOTATION', 40, 110);
  doc.font('Helvetica').fontSize(10).fillColor('#475569')
     .text('Quote No: ', 40, 135, { continued: true })
     .font('Helvetica-Bold').fillColor('#0F172A').text(q.number || '—');
  doc.font('Helvetica').fillColor('#475569')
     .text('Issue Date: ', 40, 150, { continued: true })
     .font('Helvetica-Bold').fillColor('#0F172A').text(_formatDate(q.issue_date));
  if (q.valid_until) {
    doc.font('Helvetica').fillColor('#475569')
       .text('Valid Until: ', 40, 165, { continued: true })
       .font('Helvetica-Bold').fillColor('#0F172A').text(_formatDate(q.valid_until));
  }

  // ─── CUSTOMER BLOCK (right side) ──────────────────────────────
  const custX = doc.page.width - 240;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#475569')
     .text('BILL TO', custX, 135);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0F172A')
     .text(q.customer_name || 'Customer', custX, 150, { width: 200 });
  if (q.customer_phone) {
    doc.font('Helvetica').fontSize(9).fillColor('#475569')
       .text('Phone: ' + q.customer_phone, custX, 168);
  }
  if (q.customer_email) {
    doc.font('Helvetica').fontSize(9).fillColor('#475569')
       .text('Email: ' + q.customer_email, custX, 182);
  }
  if (q.customer_address) {
    doc.font('Helvetica').fontSize(9).fillColor('#475569')
       .text(q.customer_address, custX, 196, { width: 200 });
  }

  // ─── ITEMS TABLE ──────────────────────────────────────────────
  let y = 240;
  const cols = [
    { label: '#',           x: 40,  w: 24,  align: 'left' },
    { label: 'Description', x: 64,  w: 240, align: 'left' },
    { label: 'Qty',         x: 304, w: 50,  align: 'right' },
    { label: 'Unit',        x: 354, w: 70,  align: 'right' },
    { label: 'Disc%',       x: 424, w: 45,  align: 'right' },
    { label: 'Amount',      x: 469, w: 88,  align: 'right' }
  ];

  // Table header
  doc.rect(40, y, doc.page.width - 80, 22).fill('#F1F5F9');
  doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9);
  cols.forEach(c => doc.text(c.label, c.x + 4, y + 6, { width: c.w - 8, align: c.align }));
  y += 22;

  // Rows
  doc.font('Helvetica').fontSize(9).fillColor('#0F172A');
  items.forEach((it, i) => {
    const lineH = Math.max(20, doc.heightOfString(String(it.description || ''), { width: cols[1].w - 8 }) + 8);
    // Zebra striping
    if (i % 2 === 1) {
      doc.rect(40, y, doc.page.width - 80, lineH).fill('#FAFAFA');
      doc.fillColor('#0F172A');
    }
    const qty = Number(it.quantity || 0);
    const up  = Number(it.unit_price || 0);
    const dp  = Number(it.discount_pct || 0);
    const gross = qty * up;
    const after = gross - (gross * dp / 100);

    doc.text(String(i + 1), cols[0].x + 4, y + 4, { width: cols[0].w - 8 });
    doc.text(String(it.description || ''), cols[1].x + 4, y + 4, { width: cols[1].w - 8 });
    doc.text(String(qty), cols[2].x + 4, y + 4, { width: cols[2].w - 8, align: 'right' });
    doc.text(_money(up, cur), cols[3].x + 4, y + 4, { width: cols[3].w - 8, align: 'right' });
    doc.text(dp ? dp.toFixed(2) + '%' : '—', cols[4].x + 4, y + 4, { width: cols[4].w - 8, align: 'right' });
    doc.text(_money(after, cur), cols[5].x + 4, y + 4, { width: cols[5].w - 8, align: 'right' });
    y += lineH;

    // Page break if near bottom
    if (y > doc.page.height - 200) { doc.addPage(); y = 40; }
  });

  // ─── TOTALS BLOCK ─────────────────────────────────────────────
  y += 12;
  const totalsX = doc.page.width - 240;
  const totalsW = 200;
  const subtotal = Number(q.subtotal || 0);
  const discAmt  = Number(q.discount_amt || 0);
  const taxAmt   = Number(q.tax_amt || 0);
  const grand    = Number(q.total || 0);

  doc.font('Helvetica').fontSize(10).fillColor('#475569');
  doc.text('Subtotal', totalsX, y, { width: totalsW - 90 });
  doc.fillColor('#0F172A').text(_money(subtotal, cur), totalsX + totalsW - 100, y, { width: 100, align: 'right' });
  y += 16;
  if (discAmt > 0) {
    doc.fillColor('#475569').text('Discount', totalsX, y, { width: totalsW - 90 });
    doc.fillColor('#0F172A').text('-' + _money(discAmt, cur), totalsX + totalsW - 100, y, { width: 100, align: 'right' });
    y += 16;
  }
  if (taxAmt > 0) {
    doc.fillColor('#475569').text('Tax', totalsX, y, { width: totalsW - 90 });
    doc.fillColor('#0F172A').text(_money(taxAmt, cur), totalsX + totalsW - 100, y, { width: 100, align: 'right' });
    y += 16;
  }
  // Grand total
  doc.rect(totalsX, y, totalsW, 28).fill('#4F46E5');
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12);
  doc.text('TOTAL', totalsX + 10, y + 9);
  doc.text(_money(grand, cur), totalsX, y + 9, { width: totalsW - 10, align: 'right' });
  y += 40;

  // ─── NOTES + TERMS ────────────────────────────────────────────
  if (q.notes && q.notes.trim()) {
    if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#475569').text('Notes', 40, y);
    y += 14;
    doc.font('Helvetica').fontSize(9).fillColor('#334155')
       .text(q.notes, 40, y, { width: doc.page.width - 80 });
    y = doc.y + 12;
  }
  if (q.terms && q.terms.trim()) {
    if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#475569').text('Terms & Conditions', 40, y);
    y += 14;
    doc.font('Helvetica').fontSize(9).fillColor('#334155')
       .text(q.terms, 40, y, { width: doc.page.width - 80 });
  }

  // ─── FOOTER ───────────────────────────────────────────────────
  doc.fontSize(8).fillColor('#94A3B8').font('Helvetica')
     .text('Thank you for your business — ' + company, 40, doc.page.height - 30,
           { width: doc.page.width - 80, align: 'center' });

  doc.end();
  return doc;
}

module.exports = { renderQuotationPdf };

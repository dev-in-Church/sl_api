import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { Resend } from "resend";
import { pool } from "../config/db.js";

// Logo used in the PDF header. Put logo.png in an `assets` folder next to
// `controllers` (src/assets/logo.png) or change the path below.
// If the file is missing the PDF is still generated, just without the logo.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, "../assets/logo.png");
const LOGO = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

function range(req) {
  const from = String(req.query.from || new Date().toISOString().slice(0, 10));
  const to = String(req.query.to || from);
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(from) || !pattern.test(to) || from > to)
    throw Object.assign(new Error("Use valid from and to dates"), {
      status: 400,
    });
  return { from, to };
}

function displayDate(value) {
  const raw = String(value).slice(0, 10);
  const date = new Date(`${raw}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? raw
    : date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

async function rows(from, to, supplierProfileId) {
  const result = await pool.query(
    `SELECT md.id, md.quantity_litres, cs.session_date, cs.session_type, sp.supplier_code, sp.full_name, u.email FROM milk_deliveries md JOIN collection_sessions cs ON cs.id = md.session_id JOIN supplier_profiles sp ON sp.id = md.supplier_profile_id JOIN users u ON u.id = sp.user_id WHERE cs.session_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR sp.id = $3) ORDER BY cs.session_date DESC`,
    [from, to, supplierProfileId || null],
  );
  return result.rows;
}

function summary(deliveries, from, to) {
  const first = deliveries[0];
  return {
    from,
    to,
    supplier: first
      ? { name: first.full_name, code: first.supplier_code, email: first.email }
      : null,
    totalLitres: deliveries.reduce(
      (sum, item) => sum + Number(item.quantity_litres),
      0,
    ),
    deliveryCount: deliveries.length,
    deliveries,
  };
}

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 46, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    // Top accent strip (the dark green now lives here and in the supplier banner)
    doc.rect(0, 0, 595, 8).fill("#17372d");
    doc.rect(0, 8, 595, 2).fill("#dceccd");

    // Logo: top centre, directly on the page (no background colour)
    if (LOGO) {
      doc.image(LOGO, (595 - 150) / 2, 26, { width: 150 });
    } else {
      doc
        .fillColor("#17372d")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text("SUPERLEO", 46, 38, { width: 503, align: "center" });
    }
    doc
      .fillColor("#17372d")
      .font("Helvetica-Bold")
      .fontSize(16)
      .text("Dairy delivery report", 46, 78, { width: 503, align: "center" });
    doc
      .fillColor("#829087")
      .font("Helvetica")
      .fontSize(9)
      .text("Milk collection centre · dairy.superleo.co.ke", 46, 99, {
        width: 503,
        align: "center",
      });
    doc.moveTo(46, 118).lineTo(549, 118).lineWidth(0.75).stroke("#dce6dd");

    // Supplier banner
    doc.roundedRect(46, 128, 503, 80, 10).fill("#17372d");
    doc
      .fillColor("#ffffff")
      .fontSize(18)
      .font("Helvetica-Bold")
      .text(data.supplier?.name || "All suppliers", 64, 142);
    if (data.supplier)
      doc
        .fillColor("#b7d99d")
        .fontSize(10)
        .font("Helvetica")
        .text(
          `Supplier code: ${data.supplier.code}   ·   ${data.supplier.email}`,
          64,
          168,
        );
    doc
      .fillColor("#b7cabd")
      .fontSize(10)
      .font("Helvetica")
      .text(
        `Reporting period: ${displayDate(data.from)} - ${displayDate(data.to)}`,
        64,
        186,
      );

    doc
      .roundedRect(46, 220, 160, 62, 8)
      .fill("#eef6eb")
      .fillColor("#5a9960")
      .fontSize(9)
      .font("Helvetica")
      .text("TOTAL MILK", 60, 236)
      .fillColor("#17372d")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text(`${data.totalLitres.toFixed(2)} L`, 60, 252);
    doc
      .roundedRect(220, 220, 160, 62, 8)
      .fill("#f4eee2")
      .fillColor("#9a7440")
      .fontSize(9)
      .font("Helvetica")
      .text("DELIVERIES", 234, 236)
      .fillColor("#17372d")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text(String(data.deliveryCount), 234, 252);
    let y = 320;
    const x = [46, 172, 280, 390];
    doc
      .rect(46, y, 503, 26)
      .fill("#17372d")
      .fillColor("#ffffff")
      .fontSize(9)
      .font("Helvetica-Bold")
      .text("DATE", 54, y + 9)
      .text("SESSION", 180, y + 9)
      .text("QUANTITY", 288, y + 9)
      .text("RECORDED", 398, y + 9);
    y += 26;
    data.deliveries.forEach((item, index) => {
      if (y > 745) {
        doc.addPage();
        y = 54;
      }
      if (index % 2 === 0) doc.rect(46, y, 503, 25).fill("#f4f7f2");
      doc
        .fillColor("#17372d")
        .font("Helvetica")
        .fontSize(9)
        .text(displayDate(item.session_date), x[0] + 8, y + 8)
        .text(
          item.session_type.charAt(0).toUpperCase() +
            item.session_type.slice(1),
          x[1] + 8,
          y + 8,
        )
        .text(`${Number(item.quantity_litres).toFixed(2)} L`, x[2] + 8, y + 8)
        .text("SuperLeo Dairy", x[3] + 8, y + 8);
      y += 25;
    });
    doc
      .fillColor("#829087")
      .fontSize(8)
      .text("Generated by SuperLeo Dairy Management", 46, 780);
    doc.end();
  });
}

export async function report(req, res, next) {
  try {
    const { from, to } = range(req);
    const deliveries = await rows(from, to, req.query.supplierProfileId);
    res.json({ data: summary(deliveries, from, to) });
  } catch (error) {
    next(error);
  }
}
export async function pdf(req, res, next) {
  try {
    const { from, to } = range(req);
    const data = summary(
      await rows(from, to, req.query.supplierProfileId),
      from,
      to,
    );
    const buffer = await buildPdf(data);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="superleo-${data.supplier?.code || "dairy"}-${from}-to-${to}.pdf"`,
    });
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}
export async function email(req, res, next) {
  try {
    const { from, to, supplierEmail, supplierProfileId } = req.body;
    if (!supplierEmail)
      return res.status(400).json({ error: "supplierEmail is required" });
    const data = summary(await rows(from, to, supplierProfileId), from, to);
    const pdf = await buildPdf(data);
    const resend = new Resend(process.env.RESEND_API_KEY || "re_placeholder");
    const { error } = await resend.emails.send(
      {
        from:
          process.env.RESEND_FROM_EMAIL ||
          "SuperLeo Reports <reports@dairy.superleo.co.ke>",
        to: [supplierEmail],
        subject: `SuperLeo milk report · ${from} to ${to}`,
        html: `<p>Hello ${data.supplier?.name || "Supplier"},</p><p>Please find your SuperLeo milk delivery report attached for ${displayDate(from)} to ${displayDate(to)}.</p><p>Regards,<br>SuperLeo Dairy Management</p>`,
        attachments: [
          {
            filename: `superleo-${data.supplier?.code || "dairy"}-${from}-to-${to}.pdf`,
            content: pdf.toString("base64"),
          },
        ],
      },
      {
        idempotencyKey: `supplier-report/${supplierProfileId || supplierEmail}/${randomUUID()}`,
      },
    );
    if (error) return res.status(502).json({ error: error.message });
    res.json({ data: { sent: true } });
  } catch (error) {
    next(error);
  }
}

// Emails to suppliers about money: payment receipts and deduction notices.
// Both functions never throw and resolve to { sent, reason? }.
import { pool } from "../config/db.js";
import { sendEmail } from "./email.service.js";

const LOGO_URL =
  process.env.EMAIL_LOGO_URL ||
  "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/superleo-Qcna9ovPl4HLITmsrTIfNSJelc9ykc.png";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const money = (n) =>
  `KSh ${Number(n).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayLabel = (value) => {
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(text);
  return Number.isNaN(date.getTime())
    ? text
    : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const dateTimeLabel = (value) =>
  new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Nairobi",
  });
const maskPhone = (phone) => {
  const p = String(phone);
  return p.length >= 9 ? `${p.slice(0, 4)}•••••${p.slice(-3)}` : p;
};

// A simple, email-client-safe layout (tables and inline styles only)
function layout({ heading, intro, rows, summary, outro }) {
  const row = ([label, value, strong]) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #edf2ed;color:#71847a;font-size:14px">${esc(label)}</td>` +
    `<td style="padding:10px 0;border-bottom:1px solid #edf2ed;text-align:right;font-size:14px;${strong ? "font-weight:700;color:#17372d" : "color:#17372d"}">${value}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f7f2;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f2;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dce6dd;border-radius:16px">
<tr><td style="padding:24px 28px 8px"><img src="${esc(LOGO_URL)}" alt="SuperLeo" height="34" style="display:block;height:34px;width:auto"></td></tr>
<tr><td style="padding:8px 28px 0"><h1 style="margin:0;font-size:20px;color:#17372d">${esc(heading)}</h1>
<p style="margin:10px 0 0;font-size:14px;line-height:22px;color:#4f6a5b">${intro}</p></td></tr>
<tr><td style="padding:16px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(row).join("")}</table></td></tr>
${summary ? `<tr><td style="padding:20px 28px 0"><p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5a9960">Your account</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summary.map(row).join("")}</table></td></tr>` : ""}
<tr><td style="padding:20px 28px 26px"><p style="margin:0;font-size:13px;line-height:20px;color:#71847a">${outro}</p></td></tr>
</table>
<p style="margin:14px 0 0;font-size:12px;color:#809087">SuperLeo Dairy Management</p>
</td></tr></table></body></html>`;
}

async function accountSummary(supplierProfileId) {
  const result = await pool.query(
    `SELECT b.earned, b.deducted, b.paid, b.balance,
            (SELECT value FROM app_settings WHERE key = 'payments_start_date') AS start_date
       FROM supplier_balances b WHERE b.supplier_profile_id = $1`,
    [supplierProfileId],
  );
  const b = result.rows[0] ?? { earned: 0, deducted: 0, paid: 0, balance: 0, start_date: null };
  const balance = Number(b.balance);
  return {
    startDate: b.start_date,
    balance,
    rows: [
      [b.start_date ? `Milk earned since ${dayLabel(b.start_date)}` : "Milk earned", money(b.earned)],
      ["Deductions", Number(b.deducted) > 0 ? `−${money(b.deducted)}` : money(0)],
      ["Total paid", money(b.paid)],
      [balance < 0 ? "You owe SuperLeo" : "Balance remaining", money(Math.abs(balance)), true],
    ],
  };
}

// Receipt for a COMPLETED payment. Sent once automatically; { force: true } re-sends it.
export async function sendPaymentReceipt(paymentId, { force = false } = {}) {
  try {
    const found = await pool.query(
      `SELECT p.*, sp.full_name, sp.supplier_code, u.email
         FROM supplier_payments p
         JOIN supplier_profiles sp ON sp.id = p.supplier_profile_id
         JOIN users u ON u.id = sp.user_id
        WHERE p.id = $1`,
      [paymentId],
    );
    if (!found.rowCount) return { sent: false, reason: "Payment not found." };
    const p = found.rows[0];
    if (p.status !== "completed")
      return { sent: false, reason: "A receipt can only be sent for a completed payment." };
    if (!force && p.receipt_emailed_at)
      return { sent: false, reason: "The receipt was already emailed." };

    const account = await accountSummary(p.supplier_profile_id);
    const when = p.completed_at ?? p.initiated_at;
    const html = layout({
      heading: "Payment received",
      intro: `Hello ${esc(p.full_name)}, we have sent <strong>${money(p.amount)}</strong> to your M-Pesa for the milk you supplied.`,
      rows: [
        ["Amount paid", money(p.amount), true],
        ["M-Pesa receipt", esc(p.mpesa_receipt || "—")],
        ["Paid to", esc(maskPhone(p.phone))],
        ["Date", esc(dateTimeLabel(when))],
        ...(p.note ? [["Note", esc(p.note)]] : []),
        ["Supplier code", esc(p.supplier_code)],
      ],
      summary: account.rows,
      outro: "Keep this email as your receipt. If anything looks wrong, please contact SuperLeo.",
    });
    const outcome = await sendEmail({
      to: p.email,
      subject: `Payment received · ${money(p.amount)}${p.mpesa_receipt ? ` · ${p.mpesa_receipt}` : ""}`,
      html,
    });
    if (outcome.sent)
      await pool.query("UPDATE supplier_payments SET receipt_emailed_at = NOW() WHERE id = $1", [p.id]);
    return outcome;
  } catch (error) {
    console.error("[email] receipt failed:", error);
    return { sent: false, reason: error.message };
  }
}

// action: "added" | "removed"
export async function sendDeductionNotice(deductionId, action = "added") {
  try {
    const found = await pool.query(
      `SELECT d.*, sp.full_name, sp.supplier_code, u.email
         FROM supplier_deductions d
         JOIN supplier_profiles sp ON sp.id = d.supplier_profile_id
         JOIN users u ON u.id = sp.user_id
        WHERE d.id = $1`,
      [deductionId],
    );
    if (!found.rowCount) return { sent: false, reason: "Deduction not found." };
    const d = found.rows[0];
    const account = await accountSummary(d.supplier_profile_id);
    const kind = { feed: "Feed", advance: "Advance", other: "Other" }[d.kind] || "Deduction";
    const removed = action === "removed";

    const html = layout({
      heading: removed ? "A deduction was removed" : "A deduction was recorded",
      intro: removed
        ? `Hello ${esc(d.full_name)}, the ${esc(kind.toLowerCase())} deduction below has been removed from your account, so it will no longer be taken off what you are owed.`
        : `Hello ${esc(d.full_name)}, a <strong>${esc(kind.toLowerCase())}</strong> deduction of <strong>${money(d.amount)}</strong> has been recorded on your account. It will be taken off what you are owed before your next payment.`,
      rows: [
        ["Type", esc(kind)],
        ...(d.description ? [["Details", esc(d.description)]] : []),
        ["Date", esc(dayLabel(d.deduction_date))],
        [removed ? "Amount removed" : "Amount deducted", money(d.amount), true],
        ["Supplier code", esc(d.supplier_code)],
      ],
      summary: account.rows,
      outro: account.balance < 0
        ? "Your deductions are currently more than what you have earned. The difference will be taken off your next deliveries. If you have questions, please contact SuperLeo."
        : "If you have questions about this deduction, please contact SuperLeo.",
    });
    return await sendEmail({
      to: d.email,
      subject: removed
        ? `Deduction removed · ${money(d.amount)}`
        : `${kind} deduction recorded · ${money(d.amount)}`,
      html,
    });
  } catch (error) {
    console.error("[email] deduction notice failed:", error);
    return { sent: false, reason: error.message };
  }
}

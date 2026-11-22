// Payments to suppliers (SuperLeo pays suppliers for their milk).
// Mount behind the same auth as the other admin routes:
//   app.use("/api/payments", paymentsRoutes);
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { toMpesaNumber } from "../utils/phone.js";
import { payoutsEnabled, sendB2C } from "../services/mpesa.service.js";
import {
  sendDeductionNotice,
  sendPaymentReceipt,
} from "../services/payment-notifications.service.js";

const router = Router();
router.use(requireAuth, requireRoles("manager", "admin"));

const MIN_AMOUNT = Number(process.env.MPESA_MIN_AMOUNT) || 10;
const MAX_AMOUNT = Number(process.env.MPESA_MAX_AMOUNT) || 150000;

const num = (value) => Number(value ?? 0);
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");
const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
const notFound = (res, what = "Not found") => res.status(404).json({ error: what });

// ---------------------------------------------------------------------------
// GET /payments/balances?search=&owedOnly=1&page=1&pageSize=20
// Every supplier with what they earned, what was deducted, what was paid, and the balance due.
router.get("/balances", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const search = String(req.query.search || "").trim();
    const owedOnly = req.query.owedOnly === "1" || req.query.owedOnly === "true";
    const like = `%${escapeLike(search)}%`;

    const from = `
      FROM supplier_profiles sp
      JOIN supplier_balances b ON b.supplier_profile_id = sp.id
     WHERE ($1::text = '' OR sp.full_name ILIKE $2 OR sp.supplier_code ILIKE $2 OR sp.phone ILIKE $2)
       AND (NOT $3::boolean OR b.balance >= 1)`;

    const [count, list, totals] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total ${from}`, [search, like, owedOnly]),
      pool.query(
        `SELECT sp.id, sp.supplier_code, sp.full_name, sp.phone, sp.is_active,
                b.earned, b.deducted, b.paid, b.balance,
                (SELECT MAX(p.completed_at) FROM supplier_payments p
                  WHERE p.supplier_profile_id = sp.id AND p.status = 'completed') AS last_paid_at,
                EXISTS (SELECT 1 FROM supplier_payments p
                         WHERE p.supplier_profile_id = sp.id
                           AND p.status IN ('pending', 'timeout')) AS payment_in_progress
           ${from}
          ORDER BY b.balance DESC, sp.full_name ASC
          LIMIT $4 OFFSET $5`,
        [search, like, owedOnly, pageSize, (page - 1) * pageSize],
      ),
      pool.query(
        `SELECT COALESCE(SUM(GREATEST(balance, 0)), 0)::numeric AS total_owed,
                COUNT(*) FILTER (WHERE balance >= 1)::int AS suppliers_owed,
                (SELECT COUNT(*)::int FROM supplier_payments WHERE status IN ('pending', 'timeout')) AS in_progress
           FROM supplier_balances`,
      ),
    ]);
    const total = count.rows[0].total;
    res.json({
      data: list.rows.map((row) => ({
        ...row,
        earned: num(row.earned),
        deducted: num(row.deducted),
        paid: num(row.paid),
        balance: num(row.balance),
      })),
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      totals: {
        totalOwed: num(totals.rows[0].total_owed),
        suppliersOwed: totals.rows[0].suppliers_owed,
        inProgress: totals.rows[0].in_progress,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /payments/suppliers/:id   one supplier's balance, deductions and payments
router.get("/suppliers/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return notFound(res, "Supplier not found");
    const supplier = await pool.query(
      "SELECT id, supplier_code, full_name, phone, is_active FROM supplier_profiles WHERE id = $1",
      [id],
    );
    if (!supplier.rowCount) return notFound(res, "Supplier not found");

    const [balance, start, deductions, payments] = await Promise.all([
      pool.query(
        "SELECT earned, deducted, paid, balance FROM supplier_balances WHERE supplier_profile_id = $1",
        [id],
      ),
      pool.query("SELECT value FROM app_settings WHERE key = 'payments_start_date'"),
      pool.query(
        `SELECT id, kind, description, amount, deduction_date, voided_at, created_at
           FROM supplier_deductions WHERE supplier_profile_id = $1
          ORDER BY deduction_date DESC, created_at DESC LIMIT 100`,
        [id],
      ),
      pool.query(
        `SELECT id, amount, phone, status, mpesa_receipt, result_desc, note, initiated_at, completed_at, receipt_emailed_at
           FROM supplier_payments WHERE supplier_profile_id = $1
          ORDER BY initiated_at DESC LIMIT 50`,
        [id],
      ),
    ]);
    const b = balance.rows[0] ?? { earned: 0, deducted: 0, paid: 0, balance: 0 };
    const row = supplier.rows[0];
    res.json({
      data: {
        supplier: { ...row, mpesa_phone: toMpesaNumber(row.phone) },
        balance: {
          earned: num(b.earned),
          deducted: num(b.deducted),
          paid: num(b.paid),
          balance: num(b.balance),
          payable: Math.max(0, Math.floor(num(b.balance))),
          minAmount: MIN_AMOUNT,
          maxAmount: MAX_AMOUNT,
          startDate: start.rows[0]?.value ?? null,
        },
        deductions: deductions.rows.map((d) => ({ ...d, amount: num(d.amount) })),
        payments: payments.rows.map((p) => ({ ...p, amount: num(p.amount) })),
        payoutsEnabled: payoutsEnabled(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /payments/suppliers/:id/deductions   { kind, description, amount, date }
router.post("/suppliers/:id/deductions", async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return notFound(res, "Supplier not found");
    const kind = ["feed", "advance", "other"].includes(req.body.kind) ? req.body.kind : "feed";
    const amount = round2(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000)
      return res.status(400).json({ error: "Enter a deduction amount greater than 0." });
    const description = String(req.body.description ?? "").trim().slice(0, 255) || null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date ?? ""))
      ? req.body.date
      : new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `INSERT INTO supplier_deductions (supplier_profile_id, kind, description, amount, deduction_date, recorded_by)
       SELECT sp.id, $2, $3, $4, $5, $6 FROM supplier_profiles sp WHERE sp.id = $1
       RETURNING id, kind, description, amount, deduction_date, voided_at, created_at`,
      [req.params.id, kind, description, amount, date, req.user.id],
    );
    if (!result.rowCount) return notFound(res, "Supplier not found");
    const notice = await sendDeductionNotice(result.rows[0].id, "added");
    res.status(201).json({
      data: { ...result.rows[0], amount: num(result.rows[0].amount) },
      emailed: notice.sent,
      emailNote: notice.sent ? undefined : notice.reason,
    });
  } catch (error) {
    next(error);
  }
});

// POST /payments/deductions/:id/void   (kept for the audit trail, not deleted)
router.post("/deductions/:id/void", async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return notFound(res, "Deduction not found");
    const result = await pool.query(
      "UPDATE supplier_deductions SET voided_at = NOW() WHERE id = $1 AND voided_at IS NULL RETURNING id",
      [req.params.id],
    );
    if (!result.rowCount) return notFound(res, "Deduction not found or already voided");
    const notice = await sendDeductionNotice(req.params.id, "removed");
    res.json({
      data: { voided: true },
      emailed: notice.sent,
      emailNote: notice.sent ? undefined : notice.reason,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /payments/suppliers/:id/pay   { amount?, phone?, note? }
// Sends the supplier's balance (or a smaller amount) to their M-Pesa number.
router.post("/suppliers/:id/pay", async (req, res, next) => {
  if (!payoutsEnabled())
    return res.status(503).json({
      error: "M-Pesa payments are not enabled. Set MPESA_ENABLED=true once Daraja is configured.",
    });
  if (!isUuid(req.params.id)) return notFound(res, "Supplier not found");

  const requestId = randomUUID();
  const client = await pool.connect();
  let payment;
  let supplier;
  try {
    await client.query("BEGIN");
    // Lock this supplier so two clicks can never both read the same balance
    const found = await client.query(
      "SELECT id, supplier_code, full_name, phone FROM supplier_profiles WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (!found.rowCount) {
      await client.query("ROLLBACK");
      return notFound(res, "Supplier not found");
    }
    supplier = found.rows[0];

    const msisdn = toMpesaNumber(req.body.phone || supplier.phone);
    if (!msisdn) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Enter a valid M-Pesa number for this supplier, for example 0712 345 678.",
      });
    }

    const balance = await client.query(
      "SELECT balance FROM supplier_balances WHERE supplier_profile_id = $1",
      [supplier.id],
    );
    const payable = Math.floor(num(balance.rows[0]?.balance));
    const raw = req.body.amount;
    const amount = raw === undefined || raw === null || raw === "" ? payable : Math.floor(Number(raw));

    let problem = null;
    if (!Number.isFinite(amount)) problem = "Enter a valid amount.";
    else if (payable < MIN_AMOUNT)
      problem = payable <= 0
        ? "Nothing is owed to this supplier right now."
        : `The balance is below the M-Pesa minimum of KSh ${MIN_AMOUNT}.`;
    else if (amount < MIN_AMOUNT) problem = `The minimum payment is KSh ${MIN_AMOUNT}.`;
    else if (amount > MAX_AMOUNT)
      problem = `The most M-Pesa can send in one payment is KSh ${MAX_AMOUNT.toLocaleString("en-KE")}. Pay a smaller amount first.`;
    else if (amount > payable)
      problem = `That is more than the balance due (KSh ${payable.toLocaleString("en-KE")}).`;
    if (problem) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: problem });
    }

    const note = String(req.body.note ?? "").trim().slice(0, 255) || null;
    const inserted = await client.query(
      `INSERT INTO supplier_payments (supplier_profile_id, amount, phone, status, request_id, note, initiated_by)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)
       RETURNING id, amount, phone, status, mpesa_receipt, result_desc, note, initiated_at, completed_at`,
      [supplier.id, amount, msisdn, requestId, note, req.user.id],
    );
    payment = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // The "one payout in flight" index tripped
    if (error.code === "23505")
      return res.status(409).json({
        error: "A payment to this supplier is already in progress. Wait for it to finish.",
      });
    return next(error);
  } finally {
    client.release();
  }

  // The money is requested OUTSIDE the transaction. The pending row above already
  // reduces the balance, so a second payout can't be started meanwhile.
  try {
    const sent = await sendB2C({
      requestId,
      amount: Number(payment.amount),
      phone: payment.phone,
      remarks: `Milk payment ${supplier.supplier_code}`,
      occasion: payment.note || "",
    });
    await pool.query(
      "UPDATE supplier_payments SET conversation_id = $1, originator_conversation_id = $2, result_desc = $3 WHERE id = $4",
      [sent.conversationId, sent.originatorConversationId, sent.description, payment.id],
    );
    res.status(202).json({
      data: { ...payment, amount: num(payment.amount), status: "pending" },
      message: "Payment sent to M-Pesa. It completes in a few seconds.",
    });
  } catch (error) {
    const definite = error.definite !== false;
    await pool.query(
      "UPDATE supplier_payments SET status = $1::text, result_desc = $2, completed_at = CASE WHEN $1::text = 'failed' THEN NOW() ELSE NULL END WHERE id = $3 AND status = 'pending'",
      [definite ? "failed" : "timeout", error.message, payment.id],
    );
    if (definite) return res.status(502).json({ error: error.message });
    res.status(202).json({
      data: { ...payment, amount: num(payment.amount), status: "timeout" },
      message: error.message,
    });
  }
});

// POST /payments/:paymentId/resolve   { outcome: "completed" | "failed", receipt? }
// For payments stuck in "pending" or "timeout" after you have checked the M-Pesa portal.
router.post("/:paymentId/resolve", async (req, res, next) => {
  try {
    if (!isUuid(req.params.paymentId)) return notFound(res, "Payment not found");
    const { outcome } = req.body;
    if (!["completed", "failed"].includes(outcome))
      return res.status(400).json({ error: "outcome must be completed or failed" });
    const receipt = String(req.body.receipt ?? "").trim().toUpperCase();
    if (outcome === "completed" && !/^[A-Z0-9]{8,12}$/.test(receipt))
      return res.status(400).json({ error: "Enter the M-Pesa receipt code for this payment." });
    const result = await pool.query(
      `UPDATE supplier_payments
          SET status = $1::text,
              mpesa_receipt = CASE WHEN $1::text = 'completed' THEN $2 ELSE mpesa_receipt END,
              result_desc = COALESCE(result_desc || ' ', '') || '(resolved manually)',
              completed_at = NOW()
        WHERE id = $3 AND status IN ('pending', 'timeout')
        RETURNING id, status`,
      [outcome, receipt || null, req.params.paymentId],
    );
    if (!result.rowCount)
      return notFound(res, "Payment not found, or it is already finished.");
    const notice =
      outcome === "completed" ? await sendPaymentReceipt(req.params.paymentId) : null;
    res.json({
      data: result.rows[0],
      emailed: notice ? notice.sent : undefined,
      emailNote: notice && !notice.sent ? notice.reason : undefined,
    });
  } catch (error) {
    next(error);
  }
});

// POST /payments/:paymentId/receipt   (emails, or re-emails, the receipt for a completed payment)
router.post("/:paymentId/receipt", async (req, res, next) => {
  try {
    if (!isUuid(req.params.paymentId)) return notFound(res, "Payment not found");
    const outcome = await sendPaymentReceipt(req.params.paymentId, { force: true });
    if (!outcome.sent) return res.status(502).json({ error: outcome.reason });
    res.json({ data: { emailed: true } });
  } catch (error) {
    next(error);
  }
});

export default router;

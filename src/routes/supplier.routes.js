import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { supplierMonthlyPdf } from "../controllers/report.controller.js";
import {
  PHONE_INVALID_ERROR,
  PHONE_REQUIRED_ERROR,
  validPhone,
} from "../utils/phone.js";

const router = Router();
router.use(requireAuth, requireRoles("supplier"));

// Deactivated suppliers lose access to their data straight away, even if they
// still hold a valid token.
router.use(async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT is_active FROM supplier_profiles WHERE user_id = $1",
      [req.user.id],
    );
    if (result.rows[0]?.is_active === false)
      return res.status(403).json({
        error: "This account has been deactivated. Please contact SuperLeo.",
      });
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/profile", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, user_id, supplier_code, full_name, phone, address, is_active, created_at, updated_at FROM supplier_profiles WHERE user_id = $1",
      [req.user.id],
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
// PATCH /supplier/profile   body: { fullName, phone, address }
// Suppliers can edit their own name, phone (required) and address (email is their login).
router.patch("/profile", async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName ?? "").trim();
    const phone = String(req.body.phone ?? "").trim();
    const address = String(req.body.address ?? "").trim();
    if (fullName.length < 2)
      return res.status(400).json({ error: "Enter your full name." });
    if (fullName.length > 120)
      return res.status(400).json({ error: "That name is too long." });
    if (!phone) return res.status(400).json({ error: PHONE_REQUIRED_ERROR });
    if (!validPhone(phone))
      return res.status(400).json({ error: PHONE_INVALID_ERROR });
    if (address.length > 255)
      return res.status(400).json({ error: "That address is too long." });

    const result = await pool.query(
      "UPDATE supplier_profiles SET full_name = $1, phone = $2, address = $3, updated_at = NOW() WHERE user_id = $4 RETURNING id, user_id, supplier_code, full_name, phone, address, is_active, created_at, updated_at",
      [fullName, phone, address || null, req.user.id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Supplier profile not found" });

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
// GET /suppliers/reports/monthly?month=YYYY-MM   (PDF)
router.get("/reports/monthly", supplierMonthlyPdf);

// GET /suppliers/payments
// Read-only payment information for the logged-in supplier: balance, payments, deductions.
// Failed attempts and internal details are not shown, and nothing here reveals the pricing setup.
const maskPhone = (phone) => {
  const p = String(phone ?? "");
  return p.length >= 9 ? `${p.slice(0, 4)}•••••${p.slice(-3)}` : p;
};
router.get("/payments", async (req, res, next) => {
  try {
    const profile = await pool.query(
      "SELECT id FROM supplier_profiles WHERE user_id = $1",
      [req.user.id],
    );
    if (!profile.rowCount)
      return res.status(404).json({ error: "Supplier profile not found" });
    const id = profile.rows[0].id;

    const [balance, totals, payments, deductions, start] = await Promise.all([
      pool.query(
        "SELECT earned, deducted, balance FROM supplier_balances WHERE supplier_profile_id = $1",
        [id],
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS paid,
                COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'timeout')), 0) AS processing
           FROM supplier_payments WHERE supplier_profile_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT id, amount, status, mpesa_receipt, phone, COALESCE(completed_at, initiated_at) AS paid_at
           FROM supplier_payments
          WHERE supplier_profile_id = $1 AND status IN ('completed', 'pending', 'timeout')
          ORDER BY initiated_at DESC LIMIT 50`,
        [id],
      ),
      pool.query(
        `SELECT id, kind, description, amount, deduction_date
           FROM supplier_deductions
          WHERE supplier_profile_id = $1 AND voided_at IS NULL
          ORDER BY deduction_date DESC, created_at DESC LIMIT 100`,
        [id],
      ),
      pool.query("SELECT value FROM app_settings WHERE key = 'payments_start_date'"),
    ]);
    const b = balance.rows[0] ?? { earned: 0, deducted: 0, balance: 0 };
    res.json({
      data: {
        startDate: start.rows[0]?.value ?? null,
        balance: {
          earned: Number(b.earned),
          deducted: Number(b.deducted),
          paid: Number(totals.rows[0].paid),
          processing: Number(totals.rows[0].processing),
          balance: Number(b.balance),
        },
        payments: payments.rows.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          status: p.status === "completed" ? "completed" : "processing",
          mpesa_receipt: p.mpesa_receipt,
          phone: maskPhone(p.phone),
          paid_at: p.paid_at,
        })),
        deductions: deductions.rows.map((d) => ({ ...d, amount: Number(d.amount) })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/deliveries", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT md.*, cs.session_date, cs.session_type FROM milk_deliveries md JOIN supplier_profiles sp ON sp.id = md.supplier_profile_id JOIN collection_sessions cs ON cs.id = md.session_id WHERE sp.user_id = $1 ORDER BY cs.session_date DESC",
      [req.user.id],
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});
export default router;

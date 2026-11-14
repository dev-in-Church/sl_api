import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
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
      "SELECT * FROM supplier_profiles WHERE user_id = $1",
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
      "UPDATE supplier_profiles SET full_name = $1, phone = $2, address = $3, updated_at = NOW() WHERE user_id = $4 RETURNING *",
      [fullName, phone, address || null, req.user.id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Supplier profile not found" });

    res.json({ data: result.rows[0] });
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

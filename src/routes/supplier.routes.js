import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

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

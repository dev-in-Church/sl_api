import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRoles("manager", "admin"));
router.get("/suppliers", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT sp.*, u.email FROM supplier_profiles sp JOIN users u ON u.id = sp.user_id ORDER BY sp.created_at DESC",
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});
router.get("/overview", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS suppliers, COALESCE(SUM(md.quantity_litres), 0)::numeric AS litres FROM supplier_profiles sp LEFT JOIN milk_deliveries md ON md.supplier_profile_id = sp.id",
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
export default router;

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
router.patch("/suppliers/:id", async (req, res, next) => {
  try {
    const { fullName, phone, address } = req.body;
    const result = await pool.query(
      "UPDATE supplier_profiles SET full_name = COALESCE($1, full_name), phone = $2, address = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
      [fullName || null, phone || null, address || null, req.params.id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Supplier not found" });
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
router.delete("/suppliers/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      "UPDATE supplier_profiles SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id",
      [req.params.id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Supplier not found" });
    res.json({ data: { deleted: true } });
  } catch (error) {
    next(error);
  }
});
export default router;

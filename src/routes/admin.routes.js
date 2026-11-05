import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRoles("manager", "admin"));

// GET /admin/suppliers              -> active suppliers only (dashboard dropdown)
// GET /admin/suppliers?include=all  -> active and inactive (suppliers page)
router.get("/suppliers", async (req, res, next) => {
  try {
    const includeAll = req.query.include === "all";
    const result = await pool.query(
      "SELECT sp.*, u.email FROM supplier_profiles sp JOIN users u ON u.id = sp.user_id WHERE ($1::boolean OR sp.is_active IS NOT FALSE) ORDER BY sp.created_at DESC",
      [includeAll],
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

// PATCH /admin/suppliers/:id/status   body: { "isActive": true | false }
router.patch("/suppliers/:id/status", async (req, res, next) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean")
      return res.status(400).json({ error: "isActive must be true or false" });
    const result = await pool.query(
      "UPDATE supplier_profiles SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_active",
      [isActive, req.params.id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Supplier not found" });
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /admin/suppliers/:id
//   (no query)         -> deactivates, exactly as before
//   ?permanent=true    -> permanently deletes the supplier, their login and all their milk records
router.delete("/suppliers/:id", async (req, res, next) => {
  if (req.query.permanent !== "true") {
    try {
      const result = await pool.query(
        "UPDATE supplier_profiles SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id",
        [req.params.id],
      );
      if (!result.rowCount)
        return res.status(404).json({ error: "Supplier not found" });
      return res.json({ data: { deleted: true } });
    } catch (error) {
      return next(error);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await client.query(
      "SELECT user_id FROM supplier_profiles WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (!profile.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Supplier not found" });
    }
    const userId = profile.rows[0].user_id;
    await client.query(
      "DELETE FROM milk_deliveries WHERE supplier_profile_id = $1",
      [req.params.id],
    );
    await client.query("DELETE FROM supplier_profiles WHERE id = $1", [
      req.params.id,
    ]);
    // Only remove the login if it really is a supplier account
    await client.query(
      "DELETE FROM users WHERE id = $1 AND role = 'supplier'",
      [userId],
    );
    await client.query("COMMIT");
    res.json({ data: { deleted: true, permanent: true } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // 23503 = another table still references this supplier or user
    if (error.code === "23503")
      return res.status(409).json({
        error:
          "This supplier is linked to other records and can't be deleted. Deactivate them instead.",
      });
    next(error);
  } finally {
    client.release();
  }
});
export default router;

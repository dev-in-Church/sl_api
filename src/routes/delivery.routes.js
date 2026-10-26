import { Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import {
  listDeliveries,
  createDelivery,
} from "../controllers/delivery.controller.js";
const router = Router();
router.use(requireAuth);
router.get("/", listDeliveries);
router.post("/", requireRoles("manager", "admin"), createDelivery);
router.patch(
  "/:id",
  requireRoles("manager", "admin"),
  async (req, res, next) => {
    try {
      const { quantityLitres, sessionDate, sessionType } = req.body;
      const result = await pool.query(
        `UPDATE milk_deliveries md SET quantity_litres = COALESCE($1, md.quantity_litres), updated_at = NOW() FROM collection_sessions cs WHERE md.id = $2 AND cs.id = md.session_id RETURNING md.*`,
        [quantityLitres ? Number(quantityLitres) : null, req.params.id],
      );
      if (!result.rowCount)
        return res.status(404).json({ error: "Delivery not found" });
      if (sessionDate || sessionType)
        await pool.query(
          "UPDATE collection_sessions SET session_date = COALESCE($1, session_date), session_type = COALESCE($2, session_type) WHERE id = (SELECT session_id FROM milk_deliveries WHERE id = $3)",
          [sessionDate || null, sessionType || null, req.params.id],
        );
      res.json({ data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);
router.delete(
  "/:id",
  requireRoles("manager", "admin"),
  async (req, res, next) => {
    try {
      const result = await pool.query(
        "DELETE FROM milk_deliveries WHERE id = $1 RETURNING id",
        [req.params.id],
      );
      if (!result.rowCount)
        return res.status(404).json({ error: "Delivery not found" });
      res.json({ data: { deleted: true } });
    } catch (error) {
      next(error);
    }
  },
);
export default router;

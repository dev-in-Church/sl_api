import { pool } from "../config/db.js";

export async function listDeliveries(req, res, next) {
  try {
    const supplierId =
      req.user.role === "supplier" ? req.user.id : req.query.supplierId;
    const result = await pool.query(
      `SELECT md.id, md.quantity_litres, cs.session_date, cs.session_type, sp.full_name, sp.supplier_code FROM milk_deliveries md JOIN collection_sessions cs ON cs.id = md.session_id JOIN supplier_profiles sp ON sp.id = md.supplier_profile_id WHERE ($1::uuid IS NULL OR sp.id = $1) ORDER BY cs.session_date DESC`,
      [supplierId || null],
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
}

export async function createDelivery(req, res, next) {
  try {
    const { supplierProfileId, quantityLitres, sessionType, sessionDate } =
      req.body;
    if (
      !supplierProfileId ||
      !Number.isFinite(Number(quantityLitres)) ||
      Number(quantityLitres) <= 0 ||
      !["morning", "evening"].includes(sessionType)
    )
      return res.status(400).json({
        error:
          "supplierProfileId, positive quantityLitres, and valid sessionType are required",
      });
    const date = sessionDate || new Date().toISOString().slice(0, 10);

    // Lock the rate on this delivery: the supplier's own price, else the default (KSh 65).
    // Later price changes then never alter what is owed for milk already delivered.
    const rate = await pool.query(
      `SELECT COALESCE(
                sp.price_per_litre,
                (SELECT value::numeric FROM app_settings WHERE key = 'price_per_litre'),
                65
              ) AS price
         FROM supplier_profiles sp
        WHERE sp.id = $1`,
      [supplierProfileId],
    );
    if (!rate.rowCount)
      return res.status(404).json({ error: "Supplier not found" });

    const session = await pool.query(
      `INSERT INTO collection_sessions (session_date, session_type) VALUES ($1, $2) ON CONFLICT (session_date, session_type) DO UPDATE SET session_date = EXCLUDED.session_date RETURNING id`,
      [date, sessionType],
    );
    const result = await pool.query(
      `INSERT INTO milk_deliveries (supplier_profile_id, session_id, quantity_litres, recorded_by, price_per_litre) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        supplierProfileId,
        session.rows[0].id,
        Number(quantityLitres),
        req.user.id,
        Number(rate.rows[0].price),
      ],
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    if (error.code === "23505")
      return res.status(409).json({
        error: "A delivery already exists for this farmer and session",
      });
    next(error);
  }
}

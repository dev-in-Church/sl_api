import { pool } from "../config/db.js";

export async function dashboard(_req, res, next) {
  try {
    const result = await pool.query(
      `SELECT COUNT(DISTINCT sp.id)::int AS registered_suppliers, COALESCE(SUM(md.quantity_litres) FILTER (WHERE cs.session_type = 'morning'), 0) AS morning_litres, COALESCE(SUM(md.quantity_litres) FILTER (WHERE cs.session_type = 'evening'), 0) AS evening_litres FROM supplier_profiles sp LEFT JOIN milk_deliveries md ON md.supplier_profile_id = sp.id LEFT JOIN collection_sessions cs ON cs.id = md.session_id WHERE sp.is_active = TRUE`,
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function listSuppliers(_req, res, next) {
  try {
    const result = await pool.query(
      `SELECT sp.id, sp.supplier_code, sp.full_name, u.email, sp.phone, sp.address FROM supplier_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.is_active = TRUE AND u.is_active = TRUE ORDER BY sp.full_name ASC`,
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
}
export async function createSupplier(req, res) {
  res.status(201).json({
    message: "Persist supplier through your repository layer",
    supplier: req.body,
  });
}

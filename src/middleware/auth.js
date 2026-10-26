import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

export async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token)
      return res.status(401).json({ error: "Authentication required" });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.is_active, sp.full_name, sp.phone, sp.address FROM users u LEFT JOIN supplier_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
      [payload.sub],
    );
    if (!result.rows[0]?.is_active)
      return res.status(401).json({ error: "Account is inactive" });
    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRoles(...roles) {
  return (req, res, next) =>
    roles.includes(req.user?.role)
      ? next()
      : res.status(403).json({ error: "Insufficient permissions" });
}

// Backward-compatible singular alias for routes copied from older backend versions.
export const requireRole = (...roles) => requireRoles(...roles);

import { Router } from "express";
import { pool } from "../config/db.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRoles("manager", "admin"));

// GET /admin/suppliers              -> active suppliers only (dashboard dropdown)
// GET /admin/suppliers?include=all  -> active and inactive
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

// GET /admin/suppliers/directory  (suppliers page: search, filter, sort, pagination)
//   ?search=   name, supplier code or phone number
//   ?address=  contains match on the address
//   ?status=   all | active | inactive
//   ?sort=     records_desc | records_asc | name_asc | newest
//   ?page=1&pageSize=20
const DIRECTORY_SORTS = {
  records_desc: "records_count DESC, sp.full_name ASC",
  records_asc: "records_count ASC, sp.full_name ASC",
  name_asc: "sp.full_name ASC",
  newest: "sp.created_at DESC",
};
const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");

router.get("/suppliers/directory", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize, 10) || 20),
    );
    const search = String(req.query.search || "").trim();
    const address = String(req.query.address || "").trim();
    const status = ["active", "inactive"].includes(req.query.status)
      ? req.query.status
      : "all";
    const orderBy = DIRECTORY_SORTS[req.query.sort] || DIRECTORY_SORTS.name_asc;
    // "0712 345" and "0712345" should both find a phone number
    const digits = /^[\d\s+\-()]+$/.test(search)
      ? search.replace(/\D/g, "")
      : "";

    const filters = [
      escapeLike(search),
      escapeLike(digits),
      escapeLike(address),
      status,
    ];
    const where = `
      WHERE ($1::text = ''
             OR sp.full_name ILIKE '%' || $1::text || '%'
             OR sp.supplier_code ILIKE '%' || $1::text || '%'
             OR sp.phone ILIKE '%' || $1::text || '%'
             OR ($2::text <> '' AND regexp_replace(COALESCE(sp.phone, ''), '\\D', '', 'g') LIKE '%' || $2::text || '%'))
        AND ($3::text = '' OR sp.address ILIKE '%' || $3::text || '%')
        AND ($4::text = 'all'
             OR ($4::text = 'active' AND sp.is_active IS NOT FALSE)
             OR ($4::text = 'inactive' AND sp.is_active = FALSE))`;

    const [count, list] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total FROM supplier_profiles sp ${where}`,
        filters,
      ),
      pool.query(
        `SELECT sp.id, sp.supplier_code, sp.full_name, sp.phone, sp.address, sp.is_active, sp.created_at,
                u.email,
                COUNT(md.id)::int AS records_count,
                COALESCE(SUM(md.quantity_litres), 0)::numeric AS total_litres
           FROM supplier_profiles sp
           JOIN users u ON u.id = sp.user_id
           LEFT JOIN milk_deliveries md ON md.supplier_profile_id = sp.id
           ${where}
          GROUP BY sp.id, u.email
          ORDER BY ${orderBy}
          LIMIT $5 OFFSET $6`,
        [...filters, pageSize, (page - 1) * pageSize],
      ),
    ]);
    const total = count.rows[0].total;
    res.json({
      data: list.rows,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /admin/suppliers/addresses  (suggestions for the address filter)
router.get("/suppliers/addresses", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT DISTINCT TRIM(address) AS address FROM supplier_profiles WHERE address IS NOT NULL AND TRIM(address) <> '' ORDER BY 1 LIMIT 200",
    );
    res.json({ data: result.rows.map((row) => row.address) });
  } catch (error) {
    next(error);
  }
});

// GET /admin/suppliers/:id  (profile page)
router.get("/suppliers/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sp.*, u.email,
              COUNT(md.id)::int AS records_count,
              COALESCE(SUM(md.quantity_litres), 0)::numeric AS total_litres
         FROM supplier_profiles sp
         JOIN users u ON u.id = sp.user_id
         LEFT JOIN milk_deliveries md ON md.supplier_profile_id = sp.id
        WHERE sp.id = $1
        GROUP BY sp.id, u.email`,
      [req.params.id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Supplier not found" });
    res.json({ data: result.rows[0] });
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

// Price per litre (used by the dashboard and by reports)
router.get("/settings/price", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'price_per_litre'",
    );
    res.json({ data: { pricePerLitre: Number(result.rows[0]?.value) || 0 } });
  } catch (error) {
    next(error);
  }
});
router.put("/settings/price", async (req, res, next) => {
  try {
    const price = Number(req.body.pricePerLitre);
    if (!Number.isFinite(price) || price < 0 || price > 1000000)
      return res
        .status(400)
        .json({ error: "Enter a valid price per litre (0 or more)." });
    const rounded = Math.round(price * 100) / 100;
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
            VALUES ('price_per_litre', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(rounded)],
    );
    res.json({ data: { pricePerLitre: rounded } });
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

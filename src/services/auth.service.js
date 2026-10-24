import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

const JWT_SECRET = process.env.JWT_SECRET;

function createToken(user) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" },
  );
}

export async function registerSupplier({
  email,
  password,
  fullName,
  phone,
  address,
}) {
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role",
      [email.toLowerCase(), passwordHash, "supplier"],
    );
    const user = userResult.rows[0];
    const code = `SUP-${String(Date.now()).slice(-6)}`;
    const profileResult = await client.query(
      "INSERT INTO supplier_profiles (user_id, supplier_code, full_name, phone, address) VALUES ($1, $2, $3, $4, $5) RETURNING id, supplier_code, full_name, phone, address",
      [user.id, code, fullName, phone || null, address || null],
    );
    await client.query("COMMIT");
    return {
      token: createToken(user),
      user: { ...user, profile: profileResult.rows[0] },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function login({ email, password }) {
  const result = await pool.query(
    "SELECT id, email, password_hash, role, is_active FROM users WHERE email = $1",
    [email.toLowerCase()],
  );
  const user = result.rows[0];
  if (
    !user ||
    !user.is_active ||
    !(await bcrypt.compare(password, user.password_hash))
  )
    throw Object.assign(new Error("Invalid email or password"), {
      statusCode: 401,
    });
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [
    user.id,
  ]);
  const profile =
    user.role === "supplier"
      ? (
          await pool.query(
            "SELECT * FROM supplier_profiles WHERE user_id = $1",
            [user.id],
          )
        ).rows[0]
      : null;
  return {
    token: createToken(user),
    user: { id: user.id, email: user.email, role: user.role, profile },
  };
}

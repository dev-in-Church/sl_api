import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import {
  PHONE_INVALID_ERROR,
  PHONE_REQUIRED_ERROR,
  validPhone,
} from "../utils/phone.js";

const JWT_SECRET = process.env.JWT_SECRET;

const httpError = (status, message) =>
  Object.assign(new Error(message), { statusCode: status, status });

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
  // A phone number is required, so managers can always find the supplier by it
  const cleanPhone = String(phone ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleanPhone) throw httpError(400, PHONE_REQUIRED_ERROR);
  if (!validPhone(cleanPhone)) throw httpError(400, PHONE_INVALID_ERROR);

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
      [user.id, code, fullName, cleanPhone, address || null],
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
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    throw httpError(401, "Invalid email or password");
  // Only someone who knows the password is told the account is deactivated
  if (!user.is_active)
    throw httpError(
      403,
      "This account has been deactivated. Please contact SuperLeo.",
    );
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [
    user.id,
  ]);
  const profile =
    user.role === "supplier"
      ? (
          await pool.query(
            "SELECT id, user_id, supplier_code, full_name, phone, address, is_active, created_at, updated_at FROM supplier_profiles WHERE user_id = $1",
            [user.id],
          )
        ).rows[0]
      : null;
  return {
    token: createToken(user),
    user: { id: user.id, email: user.email, role: user.role, profile },
  };
}

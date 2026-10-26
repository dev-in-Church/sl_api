import pg from "pg";

const { Pool } = pg;

// Return Postgres DATE columns as plain "YYYY-MM-DD" strings instead of JS Date
// objects, so dates can't shift by a day with the server's time zone.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: Number(process.env.DB_POOL_MAX || 10),
});

export async function checkDatabaseConnection() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}

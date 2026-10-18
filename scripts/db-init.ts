import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set DATABASE_URL to the local TenderAI PostgreSQL database.");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString });
  try {
    const sql = await readFile(new URL("../infra/sql/001_documents.sql", import.meta.url), "utf8");
    await pool.query(sql);
    console.log("TenderAI document schema is ready.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Database setup failed.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

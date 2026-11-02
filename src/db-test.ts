import { mkdir } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";

await mkdir("./data", { recursive: true });

const instance = await DuckDBInstance.create("./data/test.duckdb");

const connection = await instance.connect();

try {
  await connection.run(`
    CREATE TABLE IF NOT EXISTS test_signals (
      symbol VARCHAR,
      timeframe VARCHAR,
      signal VARCHAR,
      created_at BIGINT
    )
  `);

  await connection.run(
    `INSERT INTO test_signals
     VALUES (?, ?, ?, ?)`,
    ["EURUSD", "1h", "BUY", Date.now()],
  );

  const result = await connection.runAndReadAll("SELECT * FROM test_signals");

  console.log("DuckDB test result:");
  console.log(result.getRowObjects());

  console.log("DuckDB connection successful.");
} finally {
  connection.disconnectSync();
}

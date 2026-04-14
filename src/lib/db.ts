import postgres from "postgres";

// Global singleton SQL connection
// Reused across all requests to avoid connection pool issues
let sqlInstance: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (!sqlInstance) {
    sqlInstance = postgres(process.env.DATABASE_URL!, {
      max: 10, // Connection pool size
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sqlInstance;
}

// Optional: Close connection (for cleanup in tests)
export async function closeSql() {
  if (sqlInstance) {
    await sqlInstance.end();
    sqlInstance = null;
  }
}

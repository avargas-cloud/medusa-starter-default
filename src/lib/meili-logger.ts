import fs from "fs";

const LOG_FILE = "/tmp/meilisearch-sync.log";

/**
 * Logger dual: escribe a console Y a archivo
 * Para WSL donde read_terminal no funciona bien
 */
export function meilineLog(message: string) {
  // Console (para ver en terminal normal)
  console.log(message);

  // Archivo (para que Claude Code pueda leer)
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `${timestamp} ${message}\n`);
  } catch (error) {
    // Silently fail si no puede escribir
  }
}

export function meilineWarn(message: string) {
  console.warn(message);
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `${timestamp} ⚠️  ${message}\n`);
  } catch (error) {
    // Silently fail
  }
}

export function meilineError(message: string, error?: any) {
  console.error(message, error);
  try {
    const timestamp = new Date().toISOString();
    const errorMsg = error?.message || error || "";
    fs.appendFileSync(LOG_FILE, `${timestamp} ❌ ${message} ${errorMsg}\n`);
  } catch (err) {
    // Silently fail
  }
}

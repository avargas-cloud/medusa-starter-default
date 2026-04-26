import * as fs from "fs";
import * as path from "path";

function walkDir(dir: string, callback: (path: string) => void) {
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, callback);
    } else {
      callback(fullPath);
    }
  });
}

let modifiedCount = 0;
walkDir("./src", (filePath) => {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // Regex to replace all instances of import { ... } from "@medusajs/framework/utils"
    // Also handling single/double quotes
    const newContent = content.replace(
      /from\s+['"]@medusajs\/framework\/utils['"]/g,
      'from "@medusajs/utils"'
    );

    if (content !== newContent) {
      fs.writeFileSync(filePath, newContent, "utf8");
      modifiedCount++;
      console.log(`Updated: ${filePath}`);
    }
  } catch (e) {
    console.error(`Failed to process ${filePath}:`, e);
  }
});

console.log(`Replaced all imports in ${modifiedCount} files.`);

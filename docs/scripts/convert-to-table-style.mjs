#!/usr/bin/env node
/**
 * convert-to-table-style.mjs
 * Converts backend docs from the old "Purpose/Solves/Expected Result" frontmatter
 * to the new frontend table style: ## 📋 Descripción del Documento
 *
 * Usage: node convert-to-table-style.mjs [--dry-run] [file.md ...]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, '..'); // backend/docs
const DRY_RUN = process.argv.includes('--dry-run');
const SPECIFIC_FILES = process.argv.filter(a => a.endsWith('.md'));

// Skip these files
const SKIP_FILES = new Set(['notebooklm-formatting-guide.md', 'README.md', 'INDEX.md']);

function extractFrontmatterFields(frontmatter) {
    const fields = { purpose: null, solves: null, expectedResult: null };

    // Extract **Purpose:** ... (multiline, until next **bold:** or end)
    const purposeMatch = frontmatter.match(/\*\*Purpose:\*\*\s*([\s\S]*?)(?=\*\*Solves:|$)/);
    if (purposeMatch) fields.purpose = purposeMatch[1].trim();

    const solvesMatch = frontmatter.match(/\*\*Solves:\*\*\s*([\s\S]*?)(?=\*\*Expected Result:|$)/);
    if (solvesMatch) fields.solves = solvesMatch[1].trim();

    const resultMatch = frontmatter.match(/\*\*Expected Result:\*\*\s*([\s\S]*?)$/);
    if (resultMatch) fields.expectedResult = resultMatch[1].trim();

    return fields;
}

function extractDocMeta(content) {
    // Try to find Last Updated, Status, Version, Audience, Author from anywhere in doc
    const meta = { lastUpdated: null, status: null, version: null };

    const luMatch = content.match(/\*\*(?:Last Updated|Última verificación)\*\*[:\s]+([^\n\r]+)/i);
    if (luMatch) meta.lastUpdated = luMatch[1].replace(/^[\s:]+/, '').trim();

    const statusMatch = content.match(/\*\*Status\*\*[:\s]+([^\n\r]+)/i);
    if (statusMatch) meta.status = statusMatch[1].replace(/^[\s:]+/, '').trim();

    return meta;
}

function convertDoc(filePath) {
    const filename = path.basename(filePath);
    if (SKIP_FILES.has(filename)) {
        console.log(`⏭️  Skipping: ${filename}`);
        return false;
    }

    let content = fs.readFileSync(filePath, 'utf8');

    // Check if already in new format
    if (content.includes('## 📋 Descripción del Documento') || content.includes('| **Propósito**') || content.includes('| **Propósito:**')) {
        console.log(`✅ Already converted: ${filename}`);
        return false;
    }

    // Must start with ---
    if (!content.startsWith('---')) {
        console.log(`⚠️  No frontmatter: ${filename}`);
        return false;
    }

    // Find the closing --- of the frontmatter
    const secondDashIdx = content.indexOf('\n---', 3);
    if (secondDashIdx === -1) {
        console.log(`⚠️  No closing ---: ${filename}`);
        return false;
    }

    const frontmatter = content.slice(3, secondDashIdx).trim();
    const rest = content.slice(secondDashIdx + 4).trim(); // after the closing ---

    const fields = extractFrontmatterFields(frontmatter);
    const meta = extractDocMeta(rest);

    // Find the title (first # heading in rest)
    const titleMatch = rest.match(/^#\s+(.+)$/m);
    const docTitle = titleMatch ? titleMatch[1].trim() : filename.replace('.md', '').replace(/_/g, ' ');

    if (!fields.purpose) {
        console.log(`⚠️  No Purpose field: ${filename}`);
        return false;
    }

    // Build the new description table
    const tableRows = [];
    tableRows.push(`| **Propósito** | ${fields.purpose} |`);

    if (fields.solves) {
        tableRows.push(`| **Problemas que resuelve** | ${fields.solves} |`);
    }

    if (fields.expectedResult) {
        tableRows.push(`| **Resultado esperado** | ${fields.expectedResult} |`);
    }

    if (meta.lastUpdated) {
        tableRows.push(`| **Última verificación** | ${meta.lastUpdated} |`);
    }

    const descSection = `## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
${tableRows.join('\n')}`;

    // Build new content: remove old frontmatter, insert description section after first # heading
    // Strategy: keep the rest (with the title), insert desc section after the title block
    let newRest = rest;

    // Insert the description section after the first heading + any immediate blockquotes/metadata
    // Find the position after the title line and any "> **Something**" metadata lines
    const lines = newRest.split('\n');
    let insertAfterLine = -1;

    // Find the title line index
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^#\s+/)) {
            // Then skip any blank lines, blockquote meta lines (> **...**) and horizontal rules after it
            let j = i + 1;
            while (j < lines.length) {
                const l = lines[j].trim();
                if (l === '' || l === '---' || l.startsWith('> ') || l.startsWith('**')) {
                    j++;
                } else {
                    break;
                }
            }
            insertAfterLine = j;
            break;
        }
    }

    if (insertAfterLine === -1) {
        // No heading found, just prepend
        newRest = `${descSection}\n\n${newRest}`;
    } else {
        // Insert the description section at insertAfterLine
        const before = lines.slice(0, insertAfterLine).join('\n');
        const after = lines.slice(insertAfterLine).join('\n');
        newRest = `${before}\n\n${descSection}\n\n${after}`;
    }

    // Remove the old frontmatter block entirely, use a clean separator at the top
    const newContent = `${newRest.trimStart()}\n`;

    if (DRY_RUN) {
        console.log(`🔍 DRY-RUN: ${filename}`);
        console.log('--- NEW HEADER (first 30 lines) ---');
        console.log(newContent.split('\n').slice(0, 30).join('\n'));
        console.log('---');
        return true;
    }

    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`✅ Converted: ${filename}`);
    return true;
}

// Get file list
let files;
if (SPECIFIC_FILES.length > 0) {
    files = SPECIFIC_FILES.map(f => path.isAbsolute(f) ? f : path.join(DOCS_DIR, f));
} else {
    files = fs.readdirSync(DOCS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(DOCS_DIR, f));
}

let converted = 0;
let skipped = 0;

for (const f of files) {
    try {
        const result = convertDoc(f);
        if (result) converted++;
        else skipped++;
    } catch (e) {
        console.error(`❌ Error: ${path.basename(f)}: ${e.message}`);
    }
}

console.log(`\nDone! Converted: ${converted}, Skipped/Already done: ${skipped}`);

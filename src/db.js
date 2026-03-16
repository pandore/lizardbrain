/**
 * db.js — SQLite helpers using the sqlite3 CLI.
 * Zero dependencies: uses child_process.execSync to call the system sqlite3 binary.
 */

const { execSync } = require('child_process');
const fs = require('fs');

function read(dbPath, query) {
  try {
    const result = execSync(
      `sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    return result.trim() ? JSON.parse(result.trim()) : [];
  } catch (err) {
    if (err.message.includes('unknown option')) {
      return readFallback(dbPath, query);
    }
    const msg = err.stderr?.toString() || err.message;
    if (msg.includes('no such table') || msg.includes('no such column')) return [];
    console.error(`[chatmem:db] read error: ${msg}`);
    return [];
  }
}

function readFallback(dbPath, query) {
  try {
    const result = execSync(
      `sqlite3 -header -separator '|||' "${dbPath}" "${query.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    const lines = result.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split('|||');
    return lines.slice(1).map(line => {
      const vals = line.split('|||');
      const obj = {};
      headers.forEach((h, i) => obj[h] = vals[i] || '');
      return obj;
    });
  } catch (err) {
    console.error(`[chatmem:db] readFallback error: ${err.stderr?.toString() || err.message}`);
    return [];
  }
}

function write(dbPath, query) {
  try {
    execSync(`sqlite3 "${dbPath}"`, {
      input: query,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    console.error(`[chatmem:db] write error: ${err.stderr?.toString() || err.message}`);
    return false;
  }
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/'/g, "''");
}

function exists(dbPath) {
  return fs.existsSync(dbPath);
}

module.exports = { read, write, esc, exists };

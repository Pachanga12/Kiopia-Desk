"use strict";

// Lógica de escaneo, hashing, exclusiones y disco, separada de main.js para
// poder testearla con `node --test` sin levantar Electron.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDES = [
  "Thumbs.db",
  "desktop.ini",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".git",
  "node_modules",
  "*.tmp",
  "~$*",
];

// --- Rutas seguras --------------------------------------------------------

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "carpeta";
}

function safePath(root, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("Ruta no válida.");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Ruta contiene caracteres nulos.");
  }
  const resolved = path.resolve(root, relativePath);
  let normalizedRoot = path.resolve(root);
  if (!normalizedRoot.endsWith(path.sep)) normalizedRoot += path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error("Ruta fuera del disco destino.");
  }
  return resolved;
}

// --- Filtros de exclusión --------------------------------------------------

function compileExcludePatterns(patterns) {
  return patterns
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => {
      const escaped = p
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp("^" + escaped + "$", "i");
    });
}

function isExcluded(name, compiledPatterns) {
  return compiledPatterns.some((re) => re.test(name));
}

// --- Escaneo recursivo -------------------------------------------------------

// E/S asíncrona (fs.promises) en vez de fs.readdirSync/statSync, para no
// bloquear el hilo del proceso principal de Electron (y con él, la ventana
// entera) mientras se escanean carpetas con muchos archivos o subcarpetas.
async function scanDirectoryRecursive(dirPath, basePath, compiledExcludes) {
  const files = {};
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    // EPERM es lo que Windows suele devolver ante carpetas protegidas (EACCES
    // casi no aparece); ENOENT cubre carpetas borradas a mitad del escaneo.
    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "ENOENT") return files;
    throw err;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (isExcluded(entry.name, compiledExcludes)) return;
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = basePath ? basePath + "/" + entry.name : entry.name;

      if (entry.isDirectory()) {
        const nested = await scanDirectoryRecursive(fullPath, relativePath, compiledExcludes);
        Object.assign(files, nested);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          files[relativePath] = {
            name: entry.name,
            path: relativePath,
            fullPath,
            size: stat.size,
            lastModified: stat.mtimeMs,
            hash: null,
          };
        } catch {
          // skip inaccessible files
        }
      }
    })
  );

  return files;
}

// --- Hashing -------------------------------------------------------------

function hashFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Hash "rápido": sólo lee los primeros y últimos 64 KB en vez del archivo
// completo. E/S asíncrona para no bloquear el proceso principal de Electron
// cuando hay muchos archivos cambiados en un mismo escaneo.
async function quickHashFile(fullPath, size) {
  const CHUNK = 65536;
  const fh = await fs.promises.open(fullPath, "r");
  try {
    const hash = crypto.createHash("sha256");
    hash.update(String(size));
    if (size > 0) {
      const headBuf = Buffer.alloc(Math.min(CHUNK, size));
      const { bytesRead: headBytes } = await fh.read(headBuf, 0, headBuf.length, 0);
      hash.update(headBuf.subarray(0, headBytes));

      if (size > CHUNK) {
        const tailSize = Math.min(CHUNK, size);
        const tailBuf = Buffer.alloc(tailSize);
        const { bytesRead: tailBytes } = await fh.read(tailBuf, 0, tailSize, size - tailSize);
        hash.update(tailBuf.subarray(0, tailBytes));
      }
    }
    return hash.digest("hex");
  } finally {
    await fh.close();
  }
}

// --- Discos y concurrencia adaptativa --------------------------------------

async function listDrives() {
  try {
    const { stdout: raw } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, FileSystemLabel, SizeRemaining, Size | ConvertTo-Json -Compress",
      ],
      { encoding: "utf-8", timeout: 10000 }
    );
    const volumes = JSON.parse(raw);
    const list = Array.isArray(volumes) ? volumes : [volumes];
    const systemDrive = (process.env.SystemDrive || "C:").toUpperCase();
    return list
      .filter((v) => v.DriveLetter)
      .map((v) => ({
        root: v.DriveLetter + ":\\",
        label: v.FileSystemLabel || "",
        free: v.SizeRemaining || 0,
        total: v.Size || 0,
        isSystemDrive: (v.DriveLetter + ":").toUpperCase() === systemDrive,
      }));
  } catch {
    return [];
  }
}

async function detectDriveType(driveRoot) {
  const letterMatch = /^([A-Za-z])/.exec(String(driveRoot || ""));
  if (!letterMatch) return { mediaType: "Unknown", busType: "Unknown" };
  const letter = letterMatch[1];

  try {
    const script =
      "$ErrorActionPreference='Stop'; " +
      `$part = Get-Partition -DriveLetter '${letter}'; ` +
      "$disk = Get-Disk -Number $part.DiskNumber; " +
      "$phys = Get-PhysicalDisk -DeviceNumber $disk.Number; " +
      "[PSCustomObject]@{ MediaType = [string]$phys.MediaType; BusType = [string]$phys.BusType } | ConvertTo-Json -Compress";
    const { stdout: raw } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 8000,
    });
    const info = JSON.parse(raw);
    return { mediaType: info.MediaType || "Unknown", busType: info.BusType || "Unknown" };
  } catch {
    return { mediaType: "Unknown", busType: "Unknown" };
  }
}

function pickConcurrency(driveInfo, avgFileSize) {
  const manySmallFiles = avgFileSize > 0 && avgFileSize < 2 * 1024 * 1024;
  const isSpinning = driveInfo.mediaType === "HDD";
  const isSSD = driveInfo.mediaType === "SSD" || driveInfo.busType === "NVMe";

  if (isSpinning) return manySmallFiles ? 2 : 1;
  if (isSSD) return manySmallFiles ? 8 : 4;
  return manySmallFiles ? 4 : 2;
}

// --- Journal de operaciones -------------------------------------------------

// Formato append-only (JSONL): la primera línea es la cabecera con todos los
// destinos planificados; después, cada archivo copiado agrega una línea con su
// ruta. Persistir "done" archivo por archivo (en vez de reescribir el journal
// cada tanto) evita que una interrupción marque como pendientes —y borre—
// archivos que en realidad ya se copiaron completos.

function startJournal(journalDirPath, tasks) {
  if (!tasks.length) return null;
  fs.mkdirSync(journalDirPath, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fp = path.join(journalDirPath, "backup_" + stamp + ".jsonl");
  const header = {
    startedAt: new Date().toISOString(),
    planned: tasks.map((t) => t.relativeDest),
  };
  fs.writeFileSync(fp, JSON.stringify(header) + "\n");
  return fp;
}

function appendJournalDone(journalPath, relativeDest) {
  try {
    fs.appendFileSync(journalPath, JSON.stringify(relativeDest) + "\n");
  } catch {
    // no crítico: sólo afecta la limpieza si el backup se interrumpe
  }
}

function finishJournal(journalPath) {
  try {
    fs.unlinkSync(journalPath);
  } catch {
    // ya no existe
  }
}

function readJournalPending(fp) {
  const raw = fs.readFileSync(fp, "utf-8");
  if (fp.endsWith(".jsonl")) {
    const lines = raw.split("\n").filter((l) => l.trim());
    const header = JSON.parse(lines[0]);
    const done = new Set();
    for (const line of lines.slice(1)) {
      try {
        done.add(JSON.parse(line));
      } catch {
        // línea cortada por la interrupción: ese archivo queda como pendiente
      }
    }
    return {
      startedAt: header.startedAt || null,
      pending: (header.planned || []).filter((p) => !done.has(p)),
    };
  }
  // Formato legado (.json): { startedAt, entries: [{ relativeDest, status }] }
  const data = JSON.parse(raw);
  return {
    startedAt: data.startedAt || null,
    pending: (data.entries || []).filter((e) => e.status !== "done").map((e) => e.relativeDest),
  };
}

// Revisa los journals SIN borrar nada: informa si quedó un backup interrumpido
// y cuántos archivos parciales hay, para que la UI pueda pedir confirmación al
// usuario antes de que checkJournals() haga la limpieza real.
function peekJournals(journalDirPath) {
  if (!fs.existsSync(journalDirPath)) return { found: 0, pendingFiles: 0, lastInterruptedAt: null };

  const files = fs.readdirSync(journalDirPath).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  let pendingFiles = 0;
  let lastInterruptedAt = null;

  for (const f of files) {
    try {
      const { startedAt, pending } = readJournalPending(path.join(journalDirPath, f));
      if (startedAt) lastInterruptedAt = startedAt;
      pendingFiles += pending.length;
    } catch {
      // journal corrupto: cuenta como interrumpido igual, checkJournals lo descartará
    }
  }

  return { found: files.length, pendingFiles, lastInterruptedAt };
}

function checkJournals(journalDirPath, destRoot) {
  if (!fs.existsSync(journalDirPath)) return { found: 0, filesCleaned: 0, lastInterruptedAt: null };

  const files = fs.readdirSync(journalDirPath).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  let filesCleaned = 0;
  let lastInterruptedAt = null;

  for (const f of files) {
    const fp = path.join(journalDirPath, f);
    try {
      const { startedAt, pending } = readJournalPending(fp);
      if (startedAt) lastInterruptedAt = startedAt;
      for (const relativeDest of pending) {
        try {
          const target = safePath(destRoot, relativeDest);
          if (fs.existsSync(target)) {
            fs.unlinkSync(target);
            filesCleaned++;
          }
        } catch {
          // ruta inválida o ya no existe: se ignora
        }
      }
    } catch {
      // journal corrupto, se descarta igual
    }
    try {
      fs.unlinkSync(fp);
    } catch {
      // ya no existe
    }
  }

  return { found: files.length, filesCleaned, lastInterruptedAt };
}

async function hideFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return false;
  try {
    await execFileAsync("attrib", ["+h", "+s", folderPath], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_EXCLUDES,
  safeName,
  safePath,
  compileExcludePatterns,
  isExcluded,
  scanDirectoryRecursive,
  hashFileAsync,
  quickHashFile,
  listDrives,
  detectDriveType,
  pickConcurrency,
  hideFolder,
  startJournal,
  appendJournalDone,
  finishJournal,
  peekJournals,
  checkJournals,
};

"use strict";

// Cifrado propio de Kopia Desk (v3). Sustituye a BitLocker: funciona en
// cualquier Windows (también Home), en cualquier disco (FAT32, exFAT, NTFS) y
// sin permisos de administrador.
//
// Algoritmos: AES-256-CBC + HMAC-SHA256 (cifrar y luego firmar) y PBKDF2-SHA256.
// No son los más modernos (AES-GCM, Argon2), pero son los que trae el
// PowerShell 5.1 de cualquier Windows 10/11: así el script de recuperación
// (lib/Recuperar-KopiaDesk.ps1) descifra el backup SIN Kopia Desk y sin
// instalar nada. Cualquier cambio de formato aquí tiene que hacerse también allí
// (los tests comprueban que los dos se entienden byte a byte).
//
// Claves:
//   - clave maestra (32 bytes al azar): no se guarda en claro nunca. Se guarda
//     envuelta (cifrada) dos veces en cifrado.json: con la contraseña y con la
//     clave de recuperación. Con cualquiera de las dos se recupera.
//   - de la maestra salen tres subclaves con HMAC (etiquetas fijas): cifrar
//     archivos, firmarlos y calcular los nombres opacos.
//
// Archivo cifrado: "KDC1" | iv (16) | AES-256-CBC(PKCS7) | HMAC-SHA256 (32)
// donde el HMAC cubre "KDC1" | iv | cifrado. Si alguien cambia un solo byte,
// el HMAC no cuadra y el archivo se rechaza (nunca se entrega algo alterado).

const crypto = require("crypto");
// Igual que lib/core.js: dentro de Electron, el fs sin el parche de .asar.
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();

const MAGIC = Buffer.from("KDC1", "ascii");
const IV_LEN = 16;
const TAG_LEN = 32;
const HEADER_LEN = MAGIC.length + IV_LEN;
const PBKDF2_ITERATIONS = 600000; // recomendación OWASP para PBKDF2-SHA256
const RECOVERY_ITERATIONS = 10000; // la clave de recuperación ya es aleatoria (160 bits)
const VAULT_FORMAT = "kopia-desk-cifrado";
const VAULT_VERSION = 1;
const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin I, O, 0, 1 (se confunden al copiarla a mano)

// --- Claves ------------------------------------------------------------------------

function deriveWrapKeys(secret, salt, iterations) {
  const k = crypto.pbkdf2Sync(secret, salt, iterations, 64, "sha256");
  return { enc: k.subarray(0, 32), mac: k.subarray(32, 64) };
}

function subkeys(masterKey) {
  const label = (s) => crypto.createHmac("sha256", masterKey).update("kopia-desk:" + s, "utf8").digest();
  return { enc: label("archivo-cifrado"), mac: label("archivo-firma"), name: label("nombre") };
}

// Envuelve (cifra y firma) la clave maestra con una clave derivada.
function wrap(masterKey, keys) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv("aes-256-cbc", keys.enc, iv);
  const data = Buffer.concat([c.update(masterKey), c.final()]);
  const mac = crypto.createHmac("sha256", keys.mac).update(iv).update(data).digest();
  return { iv: iv.toString("base64"), datos: data.toString("base64"), mac: mac.toString("base64") };
}

function unwrap(w, keys) {
  const iv = Buffer.from(w.iv, "base64");
  const data = Buffer.from(w.datos, "base64");
  const mac = crypto.createHmac("sha256", keys.mac).update(iv).update(data).digest();
  if (!crypto.timingSafeEqual(mac, Buffer.from(w.mac, "base64"))) return null; // contraseña o clave incorrecta
  const d = crypto.createDecipheriv("aes-256-cbc", keys.enc, iv);
  const mk = Buffer.concat([d.update(data), d.final()]);
  return mk.length === 32 ? mk : null;
}

// Clave de recuperación: 20 bytes al azar (160 bits) en 8 grupos de 4 letras.
function formatRecoveryKey(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{4}/g).join("-");
}

function parseRecoveryKey(text) {
  const clean = String(text || "").toUpperCase().replace(/[\s-]/g, "");
  if (clean.length !== 32 || [...clean].some((ch) => !BASE32.includes(ch))) return null;
  let bits = "";
  for (const ch of clean) bits += BASE32.indexOf(ch).toString(2).padStart(5, "0");
  const out = Buffer.alloc(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

function looksLikeRecoveryKey(text) {
  return parseRecoveryKey(text) !== null;
}

// Crea la "caja" (cifrado.json) de un disco: devuelve el JSON a guardar, la
// clave maestra (para usarla ya) y la clave de recuperación (para mostrarla UNA vez).
function createVault(password, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof password !== "string" || !password) throw new Error("Falta la contraseña.");
  const masterKey = crypto.randomBytes(32);
  const recoveryBytes = crypto.randomBytes(20);
  const salt = crypto.randomBytes(16);
  const recSalt = crypto.randomBytes(16);
  const vault = {
    formato: VAULT_FORMAT,
    version: VAULT_VERSION,
    algoritmo: "AES-256-CBC + HMAC-SHA256, PBKDF2-SHA256",
    creado: new Date().toISOString(),
    porContrasena: { sal: salt.toString("base64"), vueltas: iterations, ...wrap(masterKey, deriveWrapKeys(Buffer.from(password, "utf8"), salt, iterations)) },
    porRecuperacion: { sal: recSalt.toString("base64"), vueltas: RECOVERY_ITERATIONS, ...wrap(masterKey, deriveWrapKeys(recoveryBytes, recSalt, RECOVERY_ITERATIONS)) },
  };
  return { vault, masterKey, recoveryKey: formatRecoveryKey(recoveryBytes) };
}

function checkVault(vault) {
  if (!vault || vault.formato !== VAULT_FORMAT) throw new Error("No es una caja de cifrado de Kopia Desk.");
  if (vault.version !== VAULT_VERSION) throw new Error("Versión de cifrado no soportada: " + vault.version);
}

// Abre la caja con la contraseña o con la clave de recuperación. Devuelve la
// clave maestra, o null si no es correcta.
function unlockVault(vault, secret) {
  checkVault(vault);
  const rec = parseRecoveryKey(secret);
  if (rec) {
    const r = vault.porRecuperacion;
    const mk = unwrap(r, deriveWrapKeys(rec, Buffer.from(r.sal, "base64"), r.vueltas));
    if (mk) return mk;
  }
  if (typeof secret !== "string" || !secret) return null;
  const p = vault.porContrasena;
  return unwrap(p, deriveWrapKeys(Buffer.from(secret, "utf8"), Buffer.from(p.sal, "base64"), p.vueltas));
}

// Cambia la contraseña sin tocar los datos (sólo se vuelve a envolver la maestra).
function rewrapWithPassword(vault, masterKey, newPassword, { iterations = PBKDF2_ITERATIONS } = {}) {
  checkVault(vault);
  const salt = crypto.randomBytes(16);
  return { ...vault, porContrasena: { sal: salt.toString("base64"), vueltas: iterations, ...wrap(masterKey, deriveWrapKeys(Buffer.from(newPassword, "utf8"), salt, iterations)) } };
}

// --- Nombres opacos ------------------------------------------------------------------

// Nombre en el disco de un archivo del backup: no revela ni el nombre ni la
// carpeta. Es siempre el mismo para la misma ruta (así el backup incremental
// sabe dónde está cada archivo). Dos niveles de carpeta para no poner decenas
// de miles de archivos en una sola.
function opaqueName(masterKey, kind, logicalPath) {
  const h = crypto.createHmac("sha256", subkeys(masterKey).name).update(kind + "\0" + logicalPath, "utf8").digest("hex");
  return h.slice(0, 2) + "/" + h.slice(2, 40) + ".kdc";
}

// --- Datos pequeños (manifiestos, índices, registros) -------------------------------

function encryptBuffer(masterKey, plain) {
  const k = subkeys(masterKey);
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv("aes-256-cbc", k.enc, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const tag = crypto.createHmac("sha256", k.mac).update(MAGIC).update(iv).update(body).digest();
  return Buffer.concat([MAGIC, iv, body, tag]);
}

function decryptBuffer(masterKey, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_LEN + 16 + TAG_LEN || !blob.subarray(0, 4).equals(MAGIC)) {
    throw codedError("CRYPTO_FORMAT", "No es un archivo cifrado de Kopia Desk.");
  }
  const k = subkeys(masterKey);
  const iv = blob.subarray(4, HEADER_LEN);
  const body = blob.subarray(HEADER_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const expected = crypto.createHmac("sha256", k.mac).update(MAGIC).update(iv).update(body).digest();
  if (!crypto.timingSafeEqual(tag, expected)) throw codedError("CRYPTO_TAMPERED", "El archivo cifrado está dañado o fue alterado.");
  const d = crypto.createDecipheriv("aes-256-cbc", k.enc, iv);
  return Buffer.concat([d.update(body), d.final()]);
}

function encryptJson(masterKey, value) {
  return encryptBuffer(masterKey, Buffer.from(JSON.stringify(value), "utf8"));
}

function decryptJson(masterKey, blob) {
  return JSON.parse(decryptBuffer(masterKey, blob).toString("utf8"));
}

// --- Archivos grandes (en bloques, sin cargarlos enteros en memoria) --------------------

const CHUNK = 4 * 1024 * 1024;
// Al escribir, bloques más grandes: en una USB (Windows escribe sin caché,
// "extracción rápida") cada escritura cuesta mucho. Medido en una USB NTFS con
// 3 archivos de 64 MB: 4 MB sin reservar 1,7 MB/s; reservando el tamaño 3,7;
// 16 MB reservando 6,4 (CopyFileW, la copia sin cifrar: 8,0).
const WRITE_CHUNK = 16 * 1024 * 1024;

// Tamaño del archivo cifrado de `plainSize` bytes: cabecera, datos con relleno
// PKCS7 (siempre 1–16 bytes) y firma.
function encryptedSize(plainSize) {
  return HEADER_LEN + (Math.floor(plainSize / 16) + 1) * 16 + TAG_LEN;
}

// Cifra srcPath en dstPath (que no debe existir). Devuelve { hash, bytes } del
// contenido ORIGINAL (SHA-256), para compararlo con el del origen.
// Velocidad: reserva el tamaño final antes de escribir (sin eso, Windows
// actualiza la tabla del disco en cada bloque que agranda el archivo) y
// mientras un bloque se escribe, lee y cifra el siguiente.
async function encryptFile(masterKey, srcPath, dstPath) {
  const k = subkeys(masterKey);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-cbc", k.enc, iv);
  const mac = crypto.createHmac("sha256", k.mac).update(MAGIC).update(iv);
  const plainHash = crypto.createHash("sha256");
  const out = await fs.promises.open(dstPath, "wx");
  let bytes = 0;
  let pos = 0;
  let pending = Promise.resolve();
  // Los trozos (cabecera, datos, relleno, firma) se juntan y se escriben en
  // bloques de WRITE_CHUNK: un archivo pequeño va en UNA sola escritura. En una
  // USB NTFS, escribirlo en 4 trozos que lo agrandan cada vez hacía la copia
  // cifrada de muchos archivos pequeños casi 4 veces más lenta que la normal.
  let parts = [];
  let partsLen = 0;
  const flush = () => {
    if (!partsLen) return;
    const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLen);
    parts = [];
    partsLen = 0;
    const at = pos;
    pos += buf.length;
    // En orden y sin esperar: la siguiente escritura espera a la anterior.
    pending = pending.then(() => out.write(buf, 0, buf.length, at));
  };
  const add = (buf) => {
    if (!buf.length) return;
    parts.push(buf);
    partsLen += buf.length;
  };
  try {
    const expected = encryptedSize((await fs.promises.stat(srcPath)).size);
    // Reservar sólo si se va a escribir en varios bloques: en uno solo no ahorra
    // nada y es una escritura más en la tabla del disco. Si no se puede, se escribe igual.
    if (expected > WRITE_CHUNK) await out.truncate(expected).catch(() => {});
    add(Buffer.concat([MAGIC, iv]));
    for await (const chunk of fs.createReadStream(srcPath, { highWaterMark: WRITE_CHUNK })) {
      bytes += chunk.length;
      plainHash.update(chunk);
      const enc = cipher.update(chunk);
      mac.update(enc);
      add(enc);
      if (partsLen >= WRITE_CHUNK) {
        await pending; // como mucho un bloque escribiéndose (memoria acotada)
        flush(); // se escribe mientras se lee y cifra el siguiente
      }
    }
    const last = cipher.final();
    mac.update(last);
    add(last);
    add(mac.digest());
    await pending;
    flush();
    await pending;
    // Si el origen cambió de tamaño mientras se leía, lo reservado no coincide:
    // se deja el archivo del tamaño real (y la copia lo detecta y lo descarta).
    if (pos !== expected) await out.truncate(pos);
    await out.sync();
  } finally {
    await pending.catch(() => {});
    await out.close();
  }
  return { hash: plainHash.digest("hex"), bytes };
}

// Comprueba el HMAC y descifra srcPath. Si dstPath es null sólo verifica.
// Devuelve { hash, bytes } del contenido original. Lanza CRYPTO_TAMPERED si
// no cuadra (y en ese caso borra lo que haya escrito en dstPath).
async function decryptFile(masterKey, srcPath, dstPath = null) {
  const k = subkeys(masterKey);
  const fh = await fs.promises.open(srcPath, "r");
  let out = null;
  try {
    const { size } = await fh.stat();
    if (size < HEADER_LEN + 16 + TAG_LEN) throw codedError("CRYPTO_FORMAT", "No es un archivo cifrado de Kopia Desk.");
    const head = Buffer.alloc(HEADER_LEN);
    await fh.read(head, 0, HEADER_LEN, 0);
    if (!head.subarray(0, 4).equals(MAGIC)) throw codedError("CRYPTO_FORMAT", "No es un archivo cifrado de Kopia Desk.");
    const tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
    const mac = crypto.createHmac("sha256", k.mac).update(head);
    const bodyEnd = size - TAG_LEN;
    const buf = Buffer.alloc(CHUNK);
    // Sólo verificar (dstPath null, lo que hace la copia tras escribir): firma y
    // contenido en UNA sola lectura, porque no se entrega nada descifrado. Antes
    // se leía el archivo dos veces.
    if (!dstPath) {
      const decipher = crypto.createDecipheriv("aes-256-cbc", k.enc, head.subarray(4));
      const plainHash = crypto.createHash("sha256");
      let bytes = 0;
      for (let pos = HEADER_LEN; pos < bodyEnd; ) {
        const n = Math.min(CHUNK, bodyEnd - pos);
        const { bytesRead } = await fh.read(buf, 0, n, pos);
        const part = buf.subarray(0, bytesRead);
        mac.update(part);
        const plain = decipher.update(part);
        bytes += plain.length;
        plainHash.update(plain);
        pos += bytesRead;
      }
      if (!crypto.timingSafeEqual(mac.digest(), tag)) throw codedError("CRYPTO_TAMPERED", "El archivo cifrado está dañado o fue alterado.");
      const last = decipher.final();
      bytes += last.length;
      plainHash.update(last);
      return { hash: plainHash.digest("hex"), bytes };
    }
    // 1) Primero la firma de TODO el archivo: no se descifra nada alterado.
    for (let pos = HEADER_LEN; pos < bodyEnd; ) {
      const n = Math.min(CHUNK, bodyEnd - pos);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      mac.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    if (!crypto.timingSafeEqual(mac.digest(), tag)) throw codedError("CRYPTO_TAMPERED", "El archivo cifrado está dañado o fue alterado.");
    // 2) Descifrar.
    const decipher = crypto.createDecipheriv("aes-256-cbc", k.enc, head.subarray(4));
    const plainHash = crypto.createHash("sha256");
    let bytes = 0;
    if (dstPath) out = await fs.promises.open(dstPath, "wx");
    const emit = async (plain) => {
      if (!plain.length) return;
      bytes += plain.length;
      plainHash.update(plain);
      if (out) await out.write(plain);
    };
    for (let pos = HEADER_LEN; pos < bodyEnd; ) {
      const n = Math.min(CHUNK, bodyEnd - pos);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      await emit(decipher.update(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    await emit(decipher.final());
    if (out) await out.sync();
    return { hash: plainHash.digest("hex"), bytes };
  } catch (err) {
    if (out) {
      await out.close().catch(() => {});
      out = null;
      await fs.promises.unlink(dstPath).catch(() => {});
    }
    throw err;
  } finally {
    if (out) await out.close();
    await fh.close();
  }
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = {
  PBKDF2_ITERATIONS,
  VAULT_FORMAT,
  createVault,
  unlockVault,
  rewrapWithPassword,
  looksLikeRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  opaqueName,
  encryptBuffer,
  decryptBuffer,
  encryptJson,
  decryptJson,
  encryptFile,
  decryptFile,
};

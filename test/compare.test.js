"use strict";

// compareManifests() (renderer/compare.js) decide qué se copia en cada
// backup: es la lógica de clasificación más importante de la app y, al vivir
// en el renderer, no tenía NINGÚN test (sólo se podía probar a mano en la
// UI). Se extrajo a su propio archivo (mismo comportamiento, cero cambios de
// lógica) para poder cubrir acá los escenarios de "integridad de copias" del
// README (especialmente el problema 3) sin necesitar un DOM.

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareManifests } = require("../renderer/compare.js");

function file(path, size, lastModified, extra = {}) {
  return { path, name: path, fullPath: "C:/src/" + path, size, lastModified, hash: null, ...extra };
}

// Igual que un valor real del manifiesto: siempre incluye "path" (así lo
// deja app.js al copiar el resultado del escaneo), lo use o no cada test.
function manifestEntry(size, lastModified, hash, path = "a.txt") {
  return { path, size, lastModified, hash };
}

// Stub de hashFile: mapa ruta completa -> hash. Simula lo que devolvería
// window.kopiaAPI.hashFile sin tocar disco.
function stubHash(map) {
  return async (fullPath) => {
    if (!(fullPath in map)) throw new Error("ENOENT (stub): " + fullPath);
    return map[fullPath];
  };
}

test("archivo nuevo: no está en el manifiesto anterior", async () => {
  const current = { "a.txt": file("a.txt", 10, 1000) };
  const diff = await compareManifests(current, {}, false, stubHash({}));
  assert.deepEqual(diff.newFiles.map((f) => f.path), ["a.txt"]);
  assert.equal(diff.changedFiles.length, 0);
});

test("archivo con tamaño distinto: cambiado sin necesidad de hashear", async () => {
  const current = { "a.txt": file("a.txt", 20, 1000) };
  const previous = { "a.txt": manifestEntry(10, 1000, "hashViejo") };
  let hashCalled = false;
  const diff = await compareManifests(current, previous, false, async () => {
    hashCalled = true;
    return "no-deberia-llamarse";
  });
  assert.equal(diff.changedFiles.length, 1);
  assert.equal(hashCalled, false, "un tamaño distinto no debería disparar un hash");
});

test("fecha distinta, mismo tamaño, contenido realmente distinto: cambiado (SHA-256 completo)", async () => {
  const current = { "a.txt": file("a.txt", 10, 2000) };
  const previous = { "a.txt": manifestEntry(10, 1000, "hashViejo") };
  const diff = await compareManifests(current, previous, false, stubHash({ "C:/src/a.txt": "hashNuevo" }));
  assert.equal(diff.changedFiles.length, 1);
  assert.equal(diff.changedFiles[0].hash, "hashNuevo");
  assert.equal(diff.touchedFiles.length, 0);
});

test('fecha distinta, mismo tamaño, MISMO contenido (SHA-256 igual): "tocado", no cambiado', async () => {
  const current = { "a.txt": file("a.txt", 10, 2000) };
  const previous = { "a.txt": manifestEntry(10, 1000, "mismoHash") };
  const diff = await compareManifests(current, previous, false, stubHash({ "C:/src/a.txt": "mismoHash" }));
  assert.equal(diff.changedFiles.length, 0, "mismo contenido no debe recopiarse");
  assert.deepEqual(diff.touchedFiles.map((f) => f.path), ["a.txt"], "sólo se actualiza la fecha en el manifiesto");
});

test("manifiesto de versión anterior sin SHA-256: se recopia una sola vez para registrarlo", async () => {
  const current = { "a.txt": file("a.txt", 10, 2000) };
  const previous = { "a.txt": manifestEntry(10, 1000, undefined) }; // sin campo hash
  let hashCalled = false;
  const diff = await compareManifests(current, previous, false, async () => {
    hashCalled = true;
    return "x";
  });
  assert.equal(diff.changedFiles.length, 1);
  assert.equal(hashCalled, false, "sin hash guardado no hay con qué comparar: se fuerza cambiado directamente");
});

test("archivo eliminado del origen: aparece en missingFiles", async () => {
  const previous = { "a.txt": manifestEntry(10, 1000, "h") };
  const diff = await compareManifests({}, previous, false, stubHash({}));
  assert.deepEqual(diff.missingFiles.map((f) => f.path), ["a.txt"]);
});

test('archivo "renombrado": el nombre viejo se ve como eliminado y el nuevo como nuevo', async () => {
  // No existe una detección de rename: compareManifests no relaciona rutas
  // distintas aunque el contenido sea idéntico. Esto es intencional (evita
  // falsos positivos), pero implica que un rename cuesta un backup completo
  // del archivo en vez de una operación barata.
  const previous = { "viejo.txt": manifestEntry(10, 1000, "mismoHash", "viejo.txt") };
  const current = { "nuevo.txt": file("nuevo.txt", 10, 1000, { hash: "mismoHash" }) };
  const diff = await compareManifests(current, previous, false, stubHash({}));
  assert.deepEqual(diff.newFiles.map((f) => f.path), ["nuevo.txt"]);
  assert.deepEqual(diff.missingFiles.map((f) => f.path), ["viejo.txt"]);
});

test("deep:true hashea también los que conservan tamaño y fecha (detecta más, cuesta más)", async () => {
  const current = { "a.txt": file("a.txt", 10, 1000) };
  const previous = { "a.txt": manifestEntry(10, 1000, "hashViejo") };
  const diff = await compareManifests(current, previous, true, stubHash({ "C:/src/a.txt": "hashNuevo" }));
  assert.equal(diff.changedFiles.length, 1, "con deep, un contenido distinto se detecta aunque tamaño y fecha no cambien");
});

// --- Limitación conocida (problema 3 del README) ----------------------------
// Sin `deep`, si NI el tamaño NI la fecha de modificación cambiaron, el
// archivo nunca se hashea: no hay forma de detectar un cambio de contenido
// sin leer TODOS los archivos en cada escaneo (dejaría de ser un escaneo
// rápido). Este test documenta el comportamiento actual explícitamente, para
// que un cambio futuro que lo modifique sea una decisión consciente y no una
// regresión silenciosa.
test("LIMITACIÓN CONOCIDA: mismo tamaño Y misma fecha con contenido distinto no se detecta sin deep:true", async () => {
  const current = { "a.txt": file("a.txt", 10, 1000) };
  const previous = { "a.txt": manifestEntry(10, 1000, "hashViejo") };
  let hashCalled = false;
  const diff = await compareManifests(current, previous, false, async () => {
    hashCalled = true;
    return "hashNuevoQueNuncaSeVe";
  });
  assert.equal(hashCalled, false, "no se hashea: por diseño, no por bug");
  assert.equal(diff.changedFiles.length, 0, "el archivo se considera sin cambios (falso negativo conocido)");
});

test("error al leer el archivo durante el hash de comparación: se trata como cambiado, no se pierde silenciosamente", async () => {
  const current = { "a.txt": file("a.txt", 10, 2000) };
  const previous = { "a.txt": manifestEntry(10, 1000, "hashViejo") };
  const diff = await compareManifests(current, previous, false, async () => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  });
  assert.equal(diff.changedFiles.length, 1, "un error leyendo para comparar no debe ocultar el archivo: se marca cambiado y se reintenta copiar");
});

test("progreso: onProgress se llama cada 20 archivos comparados por hash, no en cada uno", async () => {
  const current = {};
  const previous = {};
  for (let i = 0; i < 45; i++) {
    const name = `f${i}.txt`;
    current[name] = file(name, 10, 2000);
    previous[name] = manifestEntry(10, 1000, "hashViejo" + i);
  }
  const hashMap = {};
  for (let i = 0; i < 45; i++) hashMap["C:/src/f" + i + ".txt"] = "hashViejo" + i; // "tocado", no cambiado
  let calls = 0;
  await compareManifests(current, previous, false, stubHash(hashMap), () => calls++);
  assert.equal(calls, 2, "45 archivos hasheados / cada 20 = 2 llamadas de progreso (en 20 y 40)");
});

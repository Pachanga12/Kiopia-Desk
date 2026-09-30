# Kopia Desk v3 — Arquitectura del proyecto

## Qué hace la aplicación

Kopia Desk v3 es una aplicación de escritorio para Windows que hace copias de
seguridad incrementales de carpetas locales hacia discos externos o USB. Compara
el estado actual de cada carpeta contra el manifiesto del último backup, copia
sólo lo que cambió (con copia atómica y verificada por SHA-256), permite restaurar
lo que falte en el PC y, si se quiere, guarda las copias cifradas con una
contraseña (contenido y nombres), que se abren en cualquier Windows con la app
o, sin ella, con el programa que queda en el propio disco.

---

## Mapa del proyecto

```
Kopia-Desk/
├── main.js                    ← Proceso principal de Electron: único que toca disco y sistema
├── preload.js                 ← Puente seguro: lista exacta de lo que la interfaz puede pedir
├── package.json               ← Nombre, versión, scripts y configuración del instalador
├── package-lock.json          ← Versiones exactas instaladas (lo genera npm)
│
├── lib/
│   ├── core.js                ← Lógica testeable sin Electron: escaneo, hashing, copia
│   │                            verificada (también cifrada), dedup, journal, discos
│   ├── cifrado.js             ← Cifrado propio (v3): caja de claves, archivos, nombres opacos
│   ├── almacen.js             ← Dónde y cómo se guarda cada cosa en un disco cifrado
│   ├── Recuperar-KopiaDesk.ps1 ← Se copia al disco: abre las copias cifradas SIN la app
│   │                            (ventana «Abrir» y recuperación por consola)
│   └── eject-drive.ps1        ← Expulsar el disco (sin elevar)
│
├── renderer/                  ← Interfaz (sin acceso a Node.js)
│   ├── index.html             ← Estructura de la pantalla
│   ├── compare.js             ← Qué es nuevo, cambiado o eliminado (probado aparte)
│   ├── restore-tree.js        ← Árbol de carpetas para restaurar (probado aparte)
│   ├── app.js                 ← Lógica de la interfaz
│   └── styles.css             ← Estilos ("Fluent Obsidian", tema claro/oscuro)
│
├── assets/Kopia_Desk_icon.png ← Icono de la app y del instalador
│
├── test/                      ← node --test (164 tests)
│   ├── core.test.js           ← Lógica base: rutas, exclusiones, escaneo, hash, journal
│   ├── integridad.test.js     ← Problemas 1–5: copia atómica, dedup, escrituras atómicas
│   ├── cifrado.test.js        ← Cifrado: caja, clave de recuperación, alteraciones; Node ↔ PowerShell
│   ├── cifrado-copia.test.js  ← Copia, dedup, versiones y restauración cifradas en el núcleo
│   ├── almacen.test.js        ← Disco cifrado de punta a punta: nada legible en el disco
│   ├── recuperar.test.js      ← Recuperar SIN la app con el script copiado en el disco
│   ├── windows.test.js        ← Contraseña, expulsar y consultas a Windows
│   ├── disco-sistema.test.js  ← Protección del disco del sistema y cambios de disco
│   ├── excluir.test.js        ← Excluir carpetas/archivos concretos y "Último backup"
│   ├── restore-tree.test.js   ← Restaurar por carpetas (árbol y selección)
│   └── veracrypt.test.js      ← Unidades de VeraCrypt
│
├── docs/
│   ├── arquitectura.md        ← Este archivo
│   └── design-reference/      ← Mockup de referencia visual (no se integra tal cual)
│
├── .github/workflows/
│   ├── ci.yml                 ← Lint y tests en GitHub Actions (Windows y Ubuntu, Node 20 y 22)
│   └── release.yml            ← Compila y publica el instalador al subir un tag vX.Y.Z
├── LICENSE                    ← MIT
├── scripts/build.js           ← npm run build: portable y luego instalador (que la lleva dentro)
└── dist/                      ← Lo genera `npm run build` (instalador y portable/); no se sube al repo
```

## Por dónde empezar

1. **`main.js`** corre con acceso total al sistema operativo. Valida **todas** las
   rutas que le llegan de la interfaz antes de usarlas.
2. **`preload.js`** es la lista exacta de funciones que la interfaz puede usar
   (`window.kopiaAPI`). Si algo no está ahí, la interfaz no puede hacerlo.
3. **`renderer/app.js`** corre en la ventana, en sandbox, sin Node.js.
4. **`lib/core.js`** tiene la lógica que se puede probar sin Electron; `main.js`
   sólo la conecta a canales IPC.
5. **`lib/cifrado.js`** y **`lib/Recuperar-KopiaDesk.ps1`** tienen que entenderse
   byte a byte: cualquier cambio de formato se hace en los dos (los tests lo
   comprueban). Nada de la app corre como administrador.

| Quiero... | Empieza por... |
|---|---|
| Entender qué pasa al escanear/copiar | `renderer/app.js` → `scanAll()` / `backupAll()`; `lib/core.js` → `copyOneTask()` |
| Entender la copia segura y la deduplicación | `lib/core.js` → `copyFileVerified()`, `ContentIndex`, `copyOneTask()` |
| Entender el cifrado | `lib/cifrado.js` (formato), `lib/almacen.js` (disco), `main.js` → "Backup cifrado (v3)" y `crypto:*`; `renderer/app.js` → "Cifrado de las copias" |
| Entender qué rutas acepta el proceso principal | `main.js` → "Validación de rutas que llegan del renderer" |
| Ver los canales IPC | más abajo, "Canales IPC" |

---

## Proceso principal (`main.js`)

1. **Ventana**: sin marco (controles propios), `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: true`; se bloquean ventanas nuevas
   (`setWindowOpenHandler` → `deny`) y la navegación (`will-navigate`).
   **Instancia única** (`requestSingleInstanceLock`): una segunda apertura se
   cierra y trae al frente la ventana existente.
2. **Validación de rutas** (lista blanca en memoria, `allowed`):
   - discos destino: sólo los que devuelve `listDrives`;
   - orígenes: sólo carpetas elegidas por diálogo, accesos rápidos o guardadas en
     la configuración (que a su vez sólo guarda orígenes autorizados);
   - restauración: carpeta destino elegida por diálogo y archivos de origen
     dentro de `<disco>\KopiaDesk_Backup`;
   - destinos de copia dentro de `KopiaDesk_Backup` y fuera de `.kopia-data`;
     versiones sólo dentro de `.kopia-data\versions`;
   - rutas de `sources.json` del disco: sólo para listar en "Comparar".
   - identidad del disco destino: `backup:copy-files`/`backup:copy-versions`
     reciben opcionalmente `options.destVolumeId` (el `volumeId` que el
     renderer tenía al elegir el disco) y lo comparan contra el real al
     empezar el lote (`assertDestVolumeUnchanged`); si no coincide, se rechaza
     todo el lote sin copiar nada más. Sin esto, cambiar el USB a mitad de un
     backup grande por otro con la misma letra escribía el resto en el disco
     nuevo sin ningún aviso. Se chequea una vez por lote (una llamada
     `refreshDrives()` real), no por archivo.
3. **Manifiestos, índice, configuración y logs** se escriben con
   `atomicWriteFileSync` (temporal + `fsync` + `rename`). Al leer un manifiesto
   dañado se usa `.prev.json` y se avisa; `.prev.json` sólo se actualiza desde un
   manifiesto legible.
4. **Copia de backup** (`backup:copy-files`): valida cada tarea, carga siempre el
   índice de contenido, copia con `copyOneTask` y concurrencia adaptativa,
   registra el journal y devuelve `done` (ruta + SHA-256 de lo copiado y
   verificado). La interfaz sólo registra en el manifiesto lo que está en `done`.
   `content-index.json` se guarda cada `INDEX_SAVE_INTERVAL` (25) archivos
   copiados, además de al final: si el proceso se corta a mitad de un lote
   grande, los archivos ya copiados y journalados quedan completos igual, pero
   sin este guardado periódico el índice en disco no se enteraba de ellos y se
   perdía la oportunidad de deduplicarlos en el próximo backup (no se pierden
   datos, sólo se copia en vez de enlazar hasta el siguiente backup completo).
5. **Versiones** (`backup:copy-versions`): la versión anterior se comprime con
   gzip a un temporal y se renombra (`writeVersionAtomic`, en `lib/core.js`),
   planificada en el journal igual que `backup:copy-files` (con la ruta real
   final bajo `.kopia-data/versions/`, no la ruta de origen). Antes no pasaba
   por el journal: un corte a mitad de comprimir una versión dejaba un
   `.kopia-tmp` que `journal:peek`/`journal:check` nunca veían (sólo miran la
   carpeta de journal), y quedaba huérfano para siempre.
6. **Restauración**: misma copia verificada que el backup.
7. **Backup cifrado (v3)**: si el disco tiene `.kopia-data\cifrado.json`, cada
   manejador pide la clave con `destCryptoKey` (null = sin cifrar; error
   `CRYPTO_LOCKED` si está cerrado). La clave sólo vive en memoria
   (`unlockedKeys`), atada al número de serie del volumen. La interfaz sigue
   pidiendo rutas lógicas (`KopiaDesk_Backup/<carpeta>/<ruta>`) y `main.js` las
   traduce a nombres opacos en `datos\` con `lib/almacen.js`; manifiestos,
   índice, rutas recordadas e informes se guardan cifrados. Las versiones de un
   disco cifrado se enlazan (o copian) ya cifradas, sin gzip, con un
   `indice.kdc` por fecha para que el script sepa qué era cada una.
8. Usa `original-fs` (el `fs` de Node sin el parche de Electron que trata los
   `.asar` como carpetas) para poder respaldar archivos `.asar`.

### Canales IPC

| Canal | Qué hace |
|---|---|
| `drives:list` | Discos con espacio, sistema de archivos, disco físico, si es del sistema e ID de volumen |
| `dialog:select-folder` / `dialog:select-restore-target` | Diálogos nativos; lo elegido queda autorizado |
| `dialog:select-exclude` | Elegir carpetas o archivos que no se copian: sólo acepta rutas dentro de una carpeta de origen (y no la carpeta entera) |
| `folders:quick-list` | Carpetas típicas del usuario que existan (quedan autorizadas) |
| `config:default-excludes` | Exclusiones por defecto |
| `fs:scan-directory` | Escaneo recursivo con patrones y rutas excluidas: `{ files, excluded, skipped }` |
| `fs:hash-concurrency` | Cuántos SHA-256 calcular a la vez al escanear, según el disco del origen (SSD/NVMe 4, HDD 1, otros 2) |
| `fs:measure-directory` | Peso de una carpeta de origen con las exclusiones: `{ bytes, files }` |
| `drives:changed` (evento del proceso principal) | Se conectó o quitó un disco: llega de `WM_DEVICECHANGE` (`DBT_DEVICEARRIVAL`, `DBT_DEVICEREMOVECOMPLETE` o `DBT_DEVNODES_CHANGED`) y sólo se envía si la lista de discos (letra e identidad de volumen) cambió de verdad |
| `fs:hash-file` / `fs:quick-hash` | SHA-256 completo / hash rápido (sólo dentro de orígenes autorizados) |
| `manifest:load` / `manifest:save` | Manifiesto con respaldo `.prev.json` y aviso si estaba dañado |
| `sources:remember` / `sources:known-paths` | Ruta local recordada por carpeta respaldada |
| `journal:peek` / `journal:check` | Detectar / limpiar un backup interrumpido |
| `backup:plan-concurrency` | Tipo de disco y concurrencia sugerida |
| `backup:copy-files` | Copia verificada con dedup, journal y progreso |
| `backup:copy-versions` | Versiones anteriores comprimidas, con journal |
| `log:save` | Log JSON de la operación (copiados, fallidos, omitidos y la marca `run` de la corrida) |
| `backup:last-run` | Último backup del disco (fecha, carpetas, copiados, fallidos), leído de esos logs |
| `backup:open-folder` | Abre `KopiaDesk_Backup` del disco en el Explorador |
| `copy:cancel` | Detener: marca el `opId` de la copia; backup, versiones y restaurar dejan de empezar archivos nuevos (el que está en curso termina) y devuelven `stopped` |
| `progress` (evento) | Además de `current`/`total`, `bytes` copiados en la llamada (tiempo restante y velocidad); fases `backup`, `versions`, `restore` |
| `app:busy` / `app:notify` | La interfaz avisa si está copiando (para cerrar bien) y pide un aviso de Windows si la ventana no está a la vista |
| `app:get-close-action` / `app:set-close-action` | Qué hace la X: `ask`, `background` o `quit` (en `kopia-desk-window.json`) |
| `restore:scan` / `restore:full-list` / `restore:list-sources` / `restore:copy-files` | Comparar y restaurar |
| `crypto:status` | `{ encrypted, unlocked, plainBackup }` del disco |
| `crypto:enable` | Activa el cifrado con la contraseña (sólo en un disco sin backup sin cifrar); devuelve la clave de recuperación una vez y copia al disco el programa para abrirlo sin la app |
| `crypto:unlock` / `crypto:lock` | Abre con la contraseña o la clave de recuperación / olvida la clave |
| `crypto:change-password` | Vuelve a envolver la clave maestra con la contraseña nueva |
| `drive:eject` | Expulsar el disco destino (quitar hardware de forma segura), comprobando identidad y que no sea el disco del sistema |
| `settings:load` / `settings:save` | Configuración del usuario |
| `window:*` | Controles de la ventana sin marco |

---

## `lib/core.js`

- **Rutas**: `safeName`, `safePath`, `safeBackupPath`, `isInside`.
- **Escrituras atómicas**: `atomicWriteFileSync`, `readJsonWithFallback`.
- **Escaneo**: `scanDirectoryRecursive` con informe de excluidos y omitidos
  (enlaces/junctions, sin permiso, ilegibles). `compileExcludes` junta los
  patrones por nombre y las rutas concretas excluidas (relativas a la carpeta
  escaneada, sin distinguir mayúsculas).
- **Detener**: `runTasks` acepta `shouldStop`; deja de empezar tareas y espera
  las que están en curso.
- **Último backup**: `summarizeLastBackup` junta los logs de la corrida más
  reciente (misma marca `run`; un log viejo sin ella cuenta solo).
- **Copia**: `copyFileVerified` con dos modos. **Backup** (`native`): copia nativa
  a `.kopia-tmp` (CopyFileW, que respeta los archivos abiertos en exclusiva por
  otro programa), `fsync`, SHA-256 del origen y del temporal en paralelo.
  **Restaurar** (`single`): una sola lectura del origen en bloques de 8 MB,
  calculando el SHA-256 mientras se escribe, y relectura del temporal. En los
  dos: comprobación de que el origen no cambió, fecha preservada y `rename`;
  hasta 3 reintentos con espera creciente ante bloqueos pasajeros (`EBUSY`,
  `EAGAIN`, `ETXTBSY`) o una verificación fallida, siempre sobre el temporal;
  `linkAtomic`, `copyOneTask`, `writeVersionAtomic` (mismo patrón temporal +
  `rename`, pero con gzip).
- **Velocidad**: `createJournalWriter` (diario por lotes: tras un corte sólo se
  borran temporales, así que no hace falta anotar cada archivo al instante),
  `ensureDir` (cada carpeta una vez por lote), `runTasks` (con muchos archivos
  pequeños de a uno, mide 100 de 1 en 1 y 100 de 2 en 2 y sigue con lo más
  rápido) y `pickRestoreConcurrency` (4 a la vez al restaurar archivos
  pequeños). El índice de dedup se guarda cada 30 s y el progreso se avisa como
  mucho cada 100 ms.
- **Consultas a Windows**: `runPowerShellQuery` usa un PowerShell que queda
  abierto mientras la app lo está (`startPowerShellWorker`), porque la primera
  consulta de discos de cada PowerShell nuevo carga módulos de almacenamiento
  (~1,45 s; en uno abierto, ~0,25 s). Sólo ejecuta las consultas fijas de
  `lib/core.js` (listar discos, tipo de disco), de a una;
  si falla o tarda demasiado se cierra y la consulta se lanza aparte, como
  antes. La primera lista de discos se pide al arrancar, en paralelo con la
  ventana, y el tipo de cada disco se recuerda por su identidad de volumen.
- **Escaneo**: `compareManifests` (renderer/compare.js) calcula los SHA-256 de
  los archivos con fecha cambiada varios a la vez según el disco del origen
  (`fs:hash-concurrency`); el resultado sale en el mismo orden que de a uno.
- **Deduplicación**: `ContentIndex` (hash → ruta y ruta → hashes; toda escritura
  olvida los hashes viejos de esa ruta), `indexEntryMatches` (verifica por
  tamaño y SHA-256 antes de enlazar).
- **Discos**: `listDrives` (con disco físico, disco del sistema e ID de volumen),
  `isProtectedSystemVolume`, `checkDriveTarget` (antes de expulsar),
  `driveIdentityChanged` (durante un backup), `fileSystemInfo` (FAT32, exFAT), `detectDriveType`,
  `pickConcurrency` (un archivo a la vez en pendrives).
- **Copia cifrada**: `encryptFileVerified`, `restoreEncryptedVerified`,
  `preserveEncryptedVersion`; `copyOneTask` cifra si `ctx.masterKey` y cuenta
  `CRYPTO_OVERHEAD` (68 bytes) en el límite de FAT32. `validateNewPassword`.
- **Expulsar**: `ejectDrive` lanza `lib/eject-drive.ps1` (sin elevar) y
  `parseEjectOutput` traduce el resultado y los vetos de Windows.
- **Journal**: `startJournal` (v2), `peekJournals`, `checkJournals` (en v2 sólo
  borra `.kopia-tmp`).

## `lib/cifrado.js` y `lib/almacen.js`

- **Formato**: AES-256-CBC + HMAC-SHA256 (cifrar y luego firmar), PBKDF2-SHA256
  (600.000 vueltas para la contraseña). Archivo: `KDC1` | IV | cifrado | HMAC,
  por bloques de 4 MB; la firma de todo el archivo se comprueba antes de
  descifrar. Se eligieron porque los trae PowerShell 5.1 de cualquier Windows.
- **Caja** (`cifrado.json` + `cifrado.copia.json`): la clave maestra envuelta
  con la contraseña y con la clave de recuperación (160 bits, 8 grupos de 4).
- **Nombres opacos**: `opaqueName(clave, tipo, rutaLógica)` = HMAC → `xx/<38 hex>.kdc`.
- **`almacen.js`**: rutas (`dataRelative`, `dataPath`, `versionRelative`),
  activar/abrir/cambiar contraseña, manifiestos `{ fuente, carpeta, archivos }`
  con `.prev.kdc`, rutas recordadas, índice, informes y el índice de versiones.
  `writeRecoveryTools` copia `Recuperar-KopiaDesk.ps1`, `Abrir-KopiaDesk.cmd`
  y `LEEME-CIFRADO.txt` a la raíz del backup (al activar y al abrir).

## `lib/Recuperar-KopiaDesk.ps1`

Corre sin elevar en PowerShell 5.1, desde el disco de backup. `-Accion Abrir`
(la de `Abrir-KopiaDesk.cmd`): ventana de contraseña y árbol de carpetas
(WinForms) con **Ver** (descifra a `%TEMP%\KopiaDesk-*`, que se borra al cerrar)
y **Sacar…** (descifrado verificado a la carpeta elegida, sin pisar nada, con la
fecha original, admite rutas largas y se puede detener). `-Accion Recuperar`:
todo a una carpeta desde la consola (lo usan los tests). `-Accion Import`: sólo
carga las funciones.

## `lib/eject-drive.ps1`

Corre sin elevar. Del volumen saca el número de disco, busca ese disco entre los
dispositivos de Windows y sube hasta el primero marcado como extraíble; sólo
entonces pide `CM_Request_Device_Eject`. Escribe `KD-EJECT:OK`,
`KD-EJECT:VETO:<tipo>:<detalle>` o `KD-EJECT:ERR:<código>:<mensaje>`.

---

## Interfaz (`renderer/`)

- **Backup**: origen (con el peso de cada carpeta) y, debajo, el **Resumen**
  (seleccionado, a copiar, libre, "Cabe / No cabe" y los botones Escanear y
  Copiar); destino (selector con ↻, panel de cifrado); opciones; resultados por
  carpeta (nuevos, cambiados, eliminados y omitidos); avisos de FAT32, cambios
  sospechosos y backup interrumpido. Una barra fija (`#actionDock`) repite el
  veredicto y los botones mientras los del Resumen no se ven
  (IntersectionObserver). Bajo el Resumen, la tarjeta **Excluir** (carpetas o
  archivos elegidos con el explorador y, plegados, los patrones por nombre).
  En la tarjeta del disco, **Último backup** con "Abrir carpeta".
- **Panel de cifrado** (`encryptionState`: `off`, `plain`, `locked`, `open`):
  campos de contraseña nueva y "Cifrar las copias"; contraseña o clave y
  "Abrir"; "Cerrar ahora", "Cambiar contraseña…", "Cerrar las copias cifradas al
  terminar el backup" y "Expulsar". La clave de recuperación se muestra una vez
  (`#recoveryDialog`, no se cierra sin confirmar). Sin cifrar, "Omitir por
  ahora" lo pliega a una línea (`data-collapsed`, recordado por `volumeId` en
  `encryptionSkipped`). Con las copias cerradas, escanear, Comparar y Restaurar
  piden la contraseña (`requireOpenBackup`).
- **Comparar** y **Restaurar**: con copia verificada. En Restaurar, cada carpeta del
  backup tiene su árbol de subcarpetas con casillas (restore-tree.js; las
  subcarpetas se dibujan al abrirlas) y se restaura dentro de una carpeta con su
  nombre (`withRestoreFolder`).
- **Disco de backup que vuelve**: al desconectarlo o expulsarlo se guarda en
  `state.lostDestination` (identidad del volumen); en cada recarga de la lista, si
  no hay destino, se busca esa identidad y se elige sola, aunque cambie la letra.
  La configuración guarda también `destinationVolumeId` para encontrarlo al abrir.

Estado principal (`state`), además de lo de la v2 original: `encryption`
(`{ encrypted, unlocked, plainBackup }`; el cifrado es opcional y sólo unas copias cerradas impiden copiar), `encryptionJob`
(cifrar, abrir o expulsar en curso), `excludePaths` (rutas excluidas) y
`encryptionSkipped` (discos con el cifrado omitido); los dos últimos se guardan
en la configuración. `destination` incluye `fileSystem`,
`maxFileSize`, `volumeId` y `onSystemDisk`.

---

## Flujo de backup

```
Usuario elige carpetas origen + disco destino
         ↓
[app.js] Escanea cada origen y carga su manifiesto anterior
         ↓
[app.js] Clasifica: NUEVO / CAMBIADO (tamaño distinto, o fecha distinta y SHA-256
         distinto) / ELIMINADO / tocado (fecha nueva, mismo contenido)
         ↓
[app.js] Usuario acepta/omite; avisos de espacio, FAT32, cifrado y cambios sospechosos
         ↓
[main.js] Valida tareas → journal → copyOneTask (dedup verificada o copia
          verificada a .kopia-tmp + rename) → devuelve lo hecho con su SHA-256
         ↓
[app.js] Manifiesto nuevo sólo con lo verificado (+ fechas de los tocados)
         ↓
[main.js] Manifiesto, índice y log con escritura atómica
         ↓
[app.js] Si se pidió, cierra las copias cifradas al terminar
```

## Estructura del backup en el disco destino

```
E:\KopiaDesk_Backup\
├── Fotos\                  ← archivos respaldados (normales, usables sin la app)
└── .kopia-data\            ← oculta (+h +s)
    ├── manifests\          ← <carpeta>.json (con SHA-256) + <carpeta>.prev.json
    ├── versions\           ← versiones anteriores .gz
    ├── journal\            ← backups en curso (v2)
    ├── logs\               ← un JSON por ejecución
    ├── content-index.json  ← hash → { path, size }
    └── sources.json        ← ruta local por carpeta
```

Cifrado, ver el README ("Cifrado de las copias"): `datos\xx\<hex>.kdc` y los
mismos metadatos en `.kdc`, más `cifrado.json` y el programa para abrirlo sin la app.

---

## Notas de desarrollo

- `npm run lint` comprueba la sintaxis de los archivos principales (`node --check`).
- Los estilos van siempre en `renderer/styles.css`: la CSP (`style-src 'self'`)
  bloquea los atributos `style="..."` del HTML (por eso existen utilidades como `.mt-14`).
- `npm test` corre los 164 tests con `node --test`; no requiere Electron. Los de
  PowerShell (cifrado cruzado, recuperar sin la app) sólo corren en Windows.
- Con npm 11 o posterior el binario de Electron no se descarga solo: ejecutar una
  vez `node node_modules/electron/install.js`.
- Compilar el instalador sin firma de código:
  `set CSC_IDENTITY_AUTO_DISCOVERY=false && npm run build` (en PowerShell:
  `$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npm run build`). Genera
  `dist/portable/KopiaDesk-Portable.exe` y `dist/Kopia Desk v3 Setup <versión>.exe`
  (con la portable en `resources/portable/`). `eject-drive.ps1` y
  `Recuperar-KopiaDesk.ps1` quedan fuera del `.asar` (`asarUnpack`) para que
  PowerShell pueda leerlos y la app pueda copiar el segundo al disco.
- Si electron-builder falla por `winCodeSign` y enlaces simbólicos, copiar el
  directorio extraído a
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`.
- `lib/Recuperar-KopiaDesk.ps1` se guarda en UTF-8 con BOM y CRLF (PowerShell 5.1
  necesita el BOM para las tildes).

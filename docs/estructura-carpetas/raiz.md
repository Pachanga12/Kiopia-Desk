# Carpeta raíz — `main.js`, `preload.js`, `package.json`

## `main.js` — el proceso principal

Es el único archivo con permiso para tocar el disco, ejecutar PowerShell o abrir
ventanas. Todo lo que hace está organizado en bloques; de arriba a abajo:

### 1. Ventana y arranque
`createWindow()` crea la ventana de Electron y carga `renderer/index.html`. Al
cerrar la última ventana, la app se cierra (`window-all-closed`).

### 2. `safePath()` — la barrera anti path-traversal
Antes de escribir cualquier archivo en el disco de backup, esta función revisa
que la ruta final quede **dentro** de la carpeta destino. Sin esto, un nombre de
archivo malicioso (`../../Windows/System32/algo`) podría escribir fuera del
backup. Se usa en cada operación de escritura.

### 3. Discos, carpetas rápidas y exclusiones
- `listDrives()` pregunta a PowerShell (`Get-Volume`) qué discos hay conectados
  y cuánto espacio libre tienen.
- `folders:quick-list` usa `app.getPath()` de Electron para resolver las
  carpetas típicas del usuario (Imágenes, Documentos, Descargas, Música,
  Videos, Escritorio) y sólo devuelve las que realmente existen en el equipo —
  así la interfaz puede ofrecerlas como accesos rápidos de un clic.
- `DEFAULT_EXCLUDES` es la lista de patrones que se ignoran al escanear
  (`Thumbs.db`, `desktop.ini`, `node_modules`, `*.tmp`, etc.). El usuario puede
  añadir los suyos desde la interfaz; `compileExcludePatterns()` los convierte
  en expresiones regulares una sola vez por escaneo.
- `scanDirectoryRecursive()` recorre una carpeta entera, salta lo excluido, y
  devuelve un mapa `{ ruta → {tamaño, fecha, ruta completa} }`. Esto es el
  "manifiesto" de una carpeta en un momento dado. Usa E/S asíncrona
  (`fs.promises`) en vez de `fs.readdirSync`/`statSync`, para no bloquear el
  proceso principal — y con él, toda la ventana — mientras escanea carpetas
  con muchos archivos.

### 4. Hashing (detectar si un archivo realmente cambió)
- `hashFileAsync()` calcula el SHA-256 completo de un archivo (lento pero
  100% preciso). Se usa sólo si el usuario activa "Verificación profunda".
- `quickHashFile()` es más barato: sólo lee los primeros y últimos 64 KB. Se usa
  por defecto cuando un archivo tiene el mismo tamaño pero distinta fecha de
  modificación, para no volver a copiar algo que en realidad no cambió de
  contenido (por ejemplo, si un antivirus sólo "tocó" el archivo).

### 5. Manifiestos y rutas recordadas
- `manifest:load` / `manifest:save` guardan el estado de cada carpeta de origen
  en `.kopia-data/manifests/<carpeta>.json`, con una copia `.prev.json` del
  estado anterior antes de sobrescribir.
- `sources:remember` / `sources:known-paths` guardan en
  `.kopia-data/sources.json` qué ruta local corresponde a cada carpeta
  respaldada, para que **restaurar no tenga que volver a preguntar** dónde
  estaba cada cosa.

### 6. Deduplicación por contenido
`copyOneTask()` es el corazón de la copia de cada archivo: calcula su hash (si
la deduplicación está activada), revisa si ya existe ese mismo contenido en
`.kopia-data/content-index.json` y, si es así, crea un **hardlink** (`fs.link`)
en vez de copiar los bytes de nuevo. Si dos archivos idénticos se copian al
mismo tiempo, un mecanismo interno (`pendingWrites`) evita que ambos se copien a
la vez — el segundo espera al primero y se enlaza a él.

### 7. Journal (registro de operaciones)
Antes de empezar a copiar un lote de archivos, se escribe un registro en
`.kopia-data/journal/` con el estado de cada archivo (pendiente/hecho). Si la
app se cierra de golpe (corte de luz, disco desconectado) a mitad de una copia
grande, la próxima vez que se elija ese mismo disco destino se detecta
(`journal:peek`, que sólo mira sin borrar) y la interfaz pregunta al usuario
antes de limpiar; al confirmar, `journal:check` borra los archivos que
quedaron a medio escribir, para que no queden restos corruptos confundidos
con un backup válido.

### 8. Concurrencia adaptativa
`detectDriveType()` le pregunta a PowerShell si el disco destino es SSD, HDD o
qué tipo de conexión usa. `pickConcurrency()` decide con esa información cuántos
archivos copiar en paralelo: más en SSD con archivos pequeños, menos en discos
mecánicos (para no forzar al cabezal a saltar de un lado a otro).

### 9. Copia, versiones, restauración
- `backup:copy-files` combina todo lo anterior: deduplica si se le pide,
  actualiza el journal, y reporta progreso en tiempo real.
- `backup:copy-versions` guarda una copia del archivo **anterior** (antes de
  sobrescribirlo) comprimida con gzip, para poder recuperar una versión vieja.
- `restore:scan` compara lo que hay en el backup contra lo que hay en el PC y
  lista lo que falta; también reporta (`lostFromBackup`) los archivos que
  figuran en el manifiesto pero ya no existen en el disco de backup, para que
  la interfaz ofrezca recopiarlos. `restore:copy-files` trae los archivos
  faltantes de vuelta al PC.

> **Nota**: se implementó y luego se quitó un cifrado AES-256-GCM por archivo —
> no aportaba suficiente frente a cifrar el disco USB completo con una
> herramienta a nivel de sistema (BitLocker, por ejemplo). Queda como posible
> mejora futura si se retoma con ese enfoque.

## `preload.js` — el puente seguro

Es literalmente la lista de funciones que la ventana puede usar. Cada línea es
un método de `window.kopiaAPI` que reenvía la llamada a `main.js` por IPC. Si
algo no aparece aquí, `renderer/app.js` no puede acceder a ello — esto es lo que
hace que `contextIsolation: true` sea seguro: la interfaz nunca tiene acceso
directo a Node.js ni al sistema de archivos.

## `package.json`

Define el nombre del paquete, las dos dependencias (`electron` y
`electron-builder`, ambas sólo de desarrollo) y dos comandos:

- `npm start` → abre la app en modo desarrollo.
- `npm run build` → genera el instalador de Windows en `dist/` usando la
  configuración de `electron-builder` (icono, `appId`, tipo `nsis`).

`package-lock.json` fija las versiones exactas de todo lo instalado; lo
mantiene npm automáticamente, no se edita a mano.

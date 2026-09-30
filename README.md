# Kopia Desk v3

[![CI](https://github.com/Pachanga12/Kopia-Desk/actions/workflows/ci.yml/badge.svg)](https://github.com/Pachanga12/Kopia-Desk/actions/workflows/ci.yml)
![Plataforma](https://img.shields.io/badge/plataforma-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![Tests](https://img.shields.io/badge/tests-166-brightgreen?logo=nodedotjs&logoColor=white)
[![Licencia](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

Aplicación de escritorio para copias de seguridad incrementales en Windows. Permite respaldar carpetas como Imágenes, Documentos o Descargas a discos externos o USB y, si quieres, guardarlas **cifradas con una contraseña**: el contenido y también los nombres de archivos y carpetas. Las copias cifradas se abren en cualquier Windows 10/11 (también Home) con Kopia Desk o, sin ella, con el programa que queda en el propio disco.

> **Estado: versión 3.0.** Este README documenta lo que la app hace hoy, los problemas detectados en revisión de código (y cuáles ya están corregidos), y el trabajo pendiente. Antes de confiarle datos que no puedas perder, lee las secciones [Problemas conocidos](#problemas-conocidos) y [Limitaciones](#limitaciones).

Kopia Desk es un proyecto independiente. No tiene relación con [Kopia](https://kopia.io) (la herramienta de backup en Go).

---

## Descargar

El instalador para Windows está en **[Releases](https://github.com/Pachanga12/Kopia-Desk/releases/latest)**: descarga `Kopia.Desk.v3.Setup.3.0.0.exe` y ejecútalo. Si no quieres instalar nada, `Kopia.Desk.v3.Portable.3.0.0.exe` se abre directamente.

- El instalador **no está firmado**: Windows SmartScreen puede mostrar "Windows protegió su PC". Pulsa **Más información → Ejecutar de todas formas**.
- **Instalar** es un asistente en español: bienvenida, licencia (hay que marcar **"Acepto los términos de la licencia"** para seguir; se muestra la traducción al español y el original en inglés) y final con **"Abrir Kopia Desk ahora"** y **"Crear acceso directo en el escritorio"** (marcadas). Se instala solo para tu usuario, sin pedir permiso de administrador.
- **Desinstalar** (desde "Agregar o quitar programas") pide confirmación, recuerda que **los backups de tus discos no se borran**, ofrece **"Borrar también mi configuración"** (desmarcada) y termina con "Muchas gracias por usar Kopia Desk". También quita el acceso directo del escritorio.
- Nada de la app pide permiso de administrador, tampoco cifrar las copias.
- Para más detalle técnico del código, ver [docs/arquitectura.md](docs/arquitectura.md).
- Página del producto: [web/index.html](web/index.html) (HTML, CSS y JS sin compilar; se abre con doble clic y se puede publicar tal cual, por ejemplo con GitHub Pages).

---

## Índice

1. [Descargar](#descargar)
1. [Cómo ejecutar](#cómo-ejecutar)
2. [Qué hace](#qué-hace)
3. [Estructura de backup en disco destino](#estructura-de-backup-en-disco-destino)
4. [Cifrado de las copias](#cifrado-de-las-copias)
5. [Problemas conocidos](#problemas-conocidos)
6. [Limitaciones](#limitaciones)
7. [Consideraciones técnicas](#consideraciones-técnicas)
8. [Seguridad](#seguridad)
9. [Plan de pruebas](#plan-de-pruebas)
10. [Hoja de ruta](#hoja-de-ruta)
11. [Recomendaciones para quien usa la app](#recomendaciones-para-quien-usa-la-app)
12. [Stack](#stack)
13. [Licencia](#licencia)

---

## Cómo ejecutar

```bash
npm install
npm start
```

> Con npm 11 o posterior, si `npm start` dice que Electron no está instalado, ejecuta una vez `node node_modules/electron/install.js` (npm ya no corre automáticamente el script que descarga el binario).

### Tests

La lógica de escaneo, hashing, copia verificada, deduplicación, exclusiones, journal y rutas seguras vive en `lib/core.js` para poder testearla sin levantar Electron:

```bash
npm test
npm run lint   # comprobación de sintaxis de main, preload, core y renderer
```

`test/core.test.js` cubre la lógica base; `test/integridad.test.js` cubre los arreglos de integridad (problemas 1 a 5), el informe de escaneo y la detección de disco y cifrado; `test/cifrado.test.js` cubre el cifrado (caja de claves, clave de recuperación, archivos alterados, nombres opacos) y que PowerShell lo entienda byte a byte; `test/cifrado-copia.test.js` y `test/almacen.test.js` cubren la copia, las versiones y la restauración cifradas y que en el disco no quede nada legible; `test/recuperar.test.js` recupera un backup cifrado **sin la app**, con el script que queda en el disco; `test/windows.test.js` cubre la contraseña, expulsar y las consultas a Windows; `test/disco-sistema.test.js` cubre la protección del disco del sistema y los cambios de disco; `test/excluir.test.js` cubre excluir carpetas o archivos concretos, la lista de excluidos con su regla, el resumen del último backup y detener una copia; `test/restore-tree.test.js` cubre restaurar por carpetas; `test/veracrypt.test.js` cubre las unidades de VeraCrypt. Los tests y el lint corren en cada push en GitHub Actions (Windows y Ubuntu, Node 20 y 22); en Ubuntu se omiten los que dependen de Windows (letras de unidad, PowerShell, bloqueos de archivo reales).

### Empaquetar como instalador

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"   # sin certificado de firma
npm run build
```

Genera, con `scripts/build.js`, `dist/portable/KopiaDesk-Portable.exe` (Kopia Desk portable, un solo `.exe` que se abre sin instalar, ~90 MB) y `dist/Kopia Desk v3 Setup <versión>.exe` (instalador NSIS, que lleva dentro la portable para copiarla a los discos de backup). El instalador **no está firmado** todavía (ver [Seguridad](#seguridad)). Más detalles en [docs/arquitectura.md](docs/arquitectura.md#notas-de-desarrollo).

En GitHub, `.github/workflows/release.yml` compila y publica el instalador automáticamente al subir un tag de versión (por ejemplo `v2.1.1`), o a mano desde la pestaña *Actions*.

---

## Qué hace

- **Selección de carpetas origen** con el diálogo nativo de Windows o con accesos rápidos a Imágenes, Documentos, Descargas, Música, Videos y Escritorio (solo aparecen las que existen). Si dos carpetas terminan con el mismo nombre, la segunda se renombra (carpeta padre o número) para no compartir manifiesto.
- **Tutorial** la primera vez que se abre la app recién instalada: sombrea la ventana y deja iluminada una parte cada vez (Origen, Destino, cifrado, Resumen, Excluir, Opciones, Comparar/Restaurar y Registro), con una explicación y **Atrás / Siguiente / Saltar tutorial** (también con las flechas y Esc). Después no vuelve a salir solo; se repite desde **Opciones → Ver el tutorial**. Quien ya usaba la app (tiene carpetas guardadas) no lo ve al actualizar.
- **Kopia Desk portable en el disco de backup:** al terminar cada backup, la app deja en `KopiaDesk_Backup\Kopia Desk (portable).exe` la versión portable (se abre en cualquier Windows sin instalar nada), de solo lectura. Sólo se copia la primera vez o cuando cambia de versión, y no si el disco se quedaría sin espacio.
- **Peso de cada carpeta** al agregarla ("12,4 GB · 3.210 archivos"), con las mismas exclusiones que el backup.
- **Resumen antes de copiar**, debajo de Origen: cuánto pesa lo seleccionado, cuánto se va a copiar de verdad tras escanear (en un backup incremental, solo lo nuevo y lo cambiado) y el espacio libre del destino, con **"Cabe" / "No cabe"** y los botones **Escanear** y **Copiar**. Si esos botones quedan fuera de la vista (muchas carpetas o pantalla baja), aparece una barra fija abajo con el mismo veredicto y los mismos botones.
- **Tiempo de la copia:** antes de copiar, el Resumen estima cuánto tardará con la velocidad medida en ese disco en backups anteriores (incluye guardar las versiones anteriores). Durante la copia: "Lleva 1:23 · quedan ~3 min · 25 MB/s"; al terminar, el registro dice cuánto tardó.
- **Detener:** un botón en la barra de progreso (backup y restauración). Deja de empezar archivos nuevos; el que está en curso termina y se verifica, así que nunca queda nada a medias. Lo copiado queda registrado y el resto sale como pendiente en el próximo escaneo.
- **Segundo plano:** al pulsar la X, la app pregunta si cerrar o seguir en segundo plano (con un icono junto al reloj de Windows para volver o salir y un aviso al terminar la copia); la elección se puede recordar y cambiar en Opciones. Si se cierra con una copia en curso, se detiene como con "Detener" antes de salir.
- **Último backup** en la tarjeta del disco destino: cuándo fue, cuántos archivos copió y un botón **Abrir carpeta** para verlo en el Explorador. Sale de los informes que la app ya deja en el disco en cada copia.
- **Detección de discos/USB** conectados con espacio disponible y sistema de archivos (NTFS, exFAT, FAT32). La lista **se actualiza sola al conectar o quitar una USB** (aviso `WM_DEVICECHANGE` de Windows, sin consultar a intervalos) y conserva el disco elegido; también hay un botón ↻ junto al selector. **El disco de backup vuelve a elegirse solo:** si lo desconectas (o lo expulsas) y lo vuelves a conectar, aunque Windows le dé otra letra, la app lo reconoce por su identidad y lo elige otra vez; al abrir la app también lo busca por su identidad. Si en su letra aparece otro disco, no se elige solo.
- **Copias cifradas con contraseña** (opcional, por disco): contenido y nombres cifrados con AES-256, clave de recuperación que se muestra una sola vez, abrir y cerrar desde el panel del disco y cambiar la contraseña. Funciona en cualquier Windows y en cualquier disco (FAT32, exFAT, NTFS), sin administrador. En el disco queda **Abrir-KopiaDesk.cmd** para ver y sacar archivos en otro PC sin Kopia Desk. Ver [Cifrado](#cifrado-de-las-copias).
- **Expulsar** el disco de forma segura desde el panel del disco.
- **Escaneo recursivo** asíncrono con barra de progreso.
- **Excluir lo que no quieres copiar**, en su propia tarjeta bajo el Resumen: con **Carpeta** y **Archivo** eliges con el explorador carpetas o archivos concretos dentro de tus carpetas de origen (se excluye esa ruta, no todo lo que se llame igual) y se quitan de la lista con ×. Plegado en **Por nombre o tipo** están las reglas por defecto como casillas (archivos de Windows `desktop.ini`/`Thumbs.db`, temporales `*.tmp`/`~$*`, `.git` y `node_modules`; desmarcar una hace que se copie) y los patrones propios (`*.iso`, `Backups_temp`). `$RECYCLE.BIN` y `System Volume Information` se ignoran siempre. Los resultados del escaneo muestran el grupo **Excluidos por filtros** con cada elemento y la regla que lo dejó fuera. Al cambiar las exclusiones se vuelve a medir el peso y hay que volver a escanear.
- **Informe de lo que queda fuera:** cada carpeta muestra un grupo "Omitidos" con enlaces/junctions (no se siguen), carpetas sin permiso y archivos ilegibles, más la cantidad de excluidos por filtros. Todo queda también en el log JSON del backup.
- **Comparación incremental** contra el último manifiesto. Si cambia el tamaño, el archivo cambió. Si solo cambió la fecha, se compara el **SHA-256 completo** contra el guardado en el manifiesto (el hash rápido de cabecera y cola ya no decide nada, ver [problema 3](#3-el-hash-rápido-decide-qué-no-se-copia)). Los archivos "tocados" sin cambios de contenido no se recopian y su fecha se actualiza en el manifiesto.
- **Detección de archivos nuevos, cambiados y eliminados.** Cada categoría se puede aceptar u omitir por carpeta. Los "eliminados" siguen guardados en el backup.
- **Aviso de cambios sospechosos:** si más de la mitad de lo respaldado cambió de golpe, o desaparecieron y aparecieron muchos archivos a la vez (patrón típico de ransomware o corrupción masiva), la copia se bloquea hasta que confirmes que lo revisaste.
- **Verificación de espacio libre en vivo.** Si lo que se va a copiar no entra, el Resumen dice cuánto falta y se deshabilita la copia.
- **Aviso de FAT32:** los archivos de 4 GB o más no caben en un disco FAT32; se avisan antes de copiar, se omiten y vuelven a aparecer en el próximo escaneo.
- **Copia a `<disco>\KopiaDesk_Backup\<carpeta>\`** con concurrencia adaptada al tipo de disco (SSD/HDD; los pendrives USB copian de a un archivo, que en pruebas resultó más rápido que en paralelo).
- **Copia atómica y verificada:** cada archivo se copia a un temporal `.kopia-tmp` junto al destino, se compara el SHA-256 del temporal contra el del origen, se comprueba que el origen no cambió durante la copia y recién entonces se renombra sobre el destino. Un corte a mitad nunca deja un archivo del backup truncado.
- **Reintentos ante bloqueos pasajeros:** si un archivo está bloqueado un instante (antivirus, indexador de búsqueda, OneDrive), la copia se reintenta hasta 3 veces con espera creciente (80, 160 y 320 ms), siempre sobre el temporal: el archivo que ya estaba en el backup no se toca mientras tanto ni si al final falla. Errores que no se arreglan esperando (sin permiso, archivo inexistente, disco lleno) fallan al primer intento.
- **El manifiesto solo registra lo que se copió y verificó**, con su SHA-256. Lo que falló (archivo en uso, disco lleno, etc.) vuelve a aparecer en el próximo escaneo.
- **Deduplicación por contenido** (SHA-256 completo): si el archivo ya existe en el backup, se crea un hardlink en vez de copiar. Antes de enlazar se verifica por hash que el archivo indexado siga teniendo ese contenido. En exFAT/FAT32 no hay hardlinks y se copia normal.
- **Versionado opcional:** antes de sobrescribir un archivo cambiado, guarda la versión anterior comprimida con gzip en `.kopia-data\versions\<fecha>\`.
- **Verificación profunda opcional:** revisa por SHA-256 completo también los archivos que conservan tamaño y fecha.
- **Journal de operaciones:** detecta backups interrumpidos (corte de luz, USB desconectado), explica qué pasó y pide confirmación antes de borrar los temporales que quedaron a medias. Nunca borra archivos del backup.
- **Pestaña Comparar:** compara carpetas del backup contra carpetas locales elegidas, detecta faltantes y permite restaurar solo esos. Detecta archivos que figuran como respaldados pero ya no están en el disco de backup.
- **Pestaña Restaurar:** trae una carpeta del backup a cualquier ubicación, útil tras formatear o con otro perfil de Windows. Con **Elegir carpetas** se abre su árbol de subcarpetas con casillas (archivos y tamaño de cada una) para restaurar sólo las marcadas. Siempre vuelve **dentro de una carpeta con su nombre**: «Capturas» restaurada en `D:\Recuperado` queda en `D:\Recuperado\Capturas\…`, con sus subcarpetas. La restauración usa la misma copia verificada.
- **Tema claro/oscuro**, ventana sin marco con controles propios y persistencia de configuración.
- **Instancia única:** si Kopia Desk ya está abierta, abrirla de nuevo trae al frente la ventana existente en vez de abrir otra (dos instancias podrían pisarse los manifiestos y la configuración).

---

## Estructura de backup en disco destino

```
D:\KopiaDesk_Backup\
├── Fotos\                    archivos respaldados (visibles, usables sin la app)
├── Documentos\
└── .kopia-data\              oculta (atributos Hidden + System)
    ├── manifests\            estado de cada carpeta, con SHA-256 (+ .prev.json)
    ├── versions\             versiones anteriores (.gz)
    ├── journal\              registro de backups en curso
    ├── logs\                 registros JSON por ejecución (copiados, fallidos, omitidos)
    ├── content-index.json    índice hash -> ruta para dedup
    └── sources.json          ruta de origen recordada por carpeta
```

Los archivos respaldados son archivos normales. Si la app no está disponible, se pueden abrir y copiar directamente desde el Explorador. Las versiones anteriores se recuperan descomprimiendo el `.gz` con cualquier herramienta (7-Zip, por ejemplo).

Con las copias cifradas (ver [Cifrado](#cifrado-de-las-copias)) no queda ningún nombre en claro:

```
D:\KopiaDesk_Backup\
├── Abrir-KopiaDesk.cmd       doble clic: ver y sacar archivos sin la app
├── Recuperar-KopiaDesk.ps1   lo que abre Abrir-KopiaDesk.cmd (y recuperación por consola)
├── LEEME-CIFRADO.txt
├── datos\3f\9a1c…e2.kdc       un archivo cifrado por archivo respaldado (nombre opaco)
└── .kopia-data\
    ├── cifrado.json          la clave maestra, envuelta con la contraseña y con la clave de recuperación
    ├── cifrado.copia.json    copia de la anterior
    ├── manifests\<opaco>.kdc registro cifrado de cada carpeta: su nombre real y el de cada archivo
    ├── versions\<fecha>\     versiones anteriores (cifradas) + indice.kdc
    ├── logs\, journal\
    ├── indice.kdc            índice de deduplicación (cifrado)
    └── fuentes.kdc           rutas de origen recordadas (cifrado)
```

Un archivo `*.kopia-tmp` dentro del backup es una copia que quedó a medias por un corte; se puede borrar sin perder nada (la app lo hace al confirmar la limpieza del journal).

---

## Cifrado de las copias

> **Estado: v3.0 en desarrollo.** Sustituye al cifrado con BitLocker de la v2, que no se podía usar en Windows Home.

### Qué se cifra y qué no

Se cifran **las copias de Kopia Desk**, no el disco entero: el contenido de cada archivo y también los nombres de archivos y carpetas, los registros (manifiestos), los informes y el índice de deduplicación. En el disco sólo quedan nombres opacos (`datos\3f\9a1c…e2.kdc`) y las fechas de cada backup. Lo que guardes a mano en el disco, fuera de Kopia Desk, no se cifra.

Es opcional y se decide por disco. Para no mezclar, sólo se activa en un disco **sin** backup previo (o vacío); un disco con copias sin cifrar lo explica y propone usar otro.

### Por qué así y no BitLocker o VeraCrypt

| | Cifrar desde Windows Home | Abrir en otro PC sin instalar nada | Pide administrador |
|---|---|---|---|
| BitLocker (v2) | No | Sí (pide la clave al conectar) | Para cifrar |
| VeraCrypt portable | Sí (instalado) | No: necesita un controlador | Sí |
| SecurStick | Sí | Sí | No, pero es cerrado, lento y depende de WebDAV, que Microsoft declaró obsoleto |
| **Kopia Desk v3** | **Sí** | **Sí** (Abrir-KopiaDesk.cmd) | **No** |

Ninguna opción puede pedir la clave sola al conectar la USB en un PC ajeno: Windows no ejecuta el `autorun.inf` de las memorias USB desde Windows 7. Siempre hace falta un doble clic en el programa del disco.

### En la app

El panel del disco destino muestra el estado y lo que se puede hacer:

| Estado | Qué muestra | ¿Se puede copiar? |
|---|---|---|
| Sin backup y sin cifrar | Aviso en rojo con los dos campos de contraseña (mínimo 8 caracteres, indicador de fortaleza) y **Cifrar las copias**. **Omitir por ahora** lo pliega a una línea («Copias sin cifrar» con **Cifrar…**) y se recuerda para ese disco | Sí, sin cifrar |
| Con copias sin cifrar | Explica que para cifrar hay que usar otro disco o uno vacío | Sí |
| Cifrado y cerrado | Campo para la **contraseña o la clave de recuperación** y **Abrir** (también con Intro) | No, hasta abrirlo |
| Cifrado y abierto | **Cerrar ahora**, **Cambiar contraseña…** y la casilla **Cerrar las copias cifradas al terminar el backup** | Sí |

**Cifrar las copias:** se confirma en una ventana que explica qué pasa si se olvida la contraseña y, al terminar, se muestra la **clave de recuperación** (8 grupos de 4 caracteres, sin letras que se confundan como O/0 o I/1) **una sola vez**, con **Copiar**. La ventana no se cierra hasta marcar «Guardé la clave de recuperación en un lugar seguro, fuera de este disco».

La clave del disco abierto sólo vive en la memoria del proceso principal mientras la app está abierta, atada al número de serie del volumen: si en esa letra aparece otro disco, hay que volver a escribir la contraseña. La contraseña no se guarda en ningún sitio y los campos se vacían al usarla.

### Sin la app (en otro PC)

En la carpeta `KopiaDesk_Backup` del disco quedan `Abrir-KopiaDesk.cmd`, `Recuperar-KopiaDesk.ps1` y `LEEME-CIFRADO.txt`, de **solo lectura** (Windows avisa antes de borrarlos). Si aun así se borran, o son de una versión anterior, la app los repone sola cada vez que se elige o se vuelve a conectar el disco (sólo escribe los que faltan o cambiaron). Después del primer backup también está **Kopia Desk (portable).exe**. Con doble clic en **Abrir-KopiaDesk.cmd**, en cualquier Windows 10/11, también Home, sin instalar nada ni permisos de administrador:

1. Pide la contraseña o la clave de recuperación.
2. Muestra las carpetas respaldadas en árbol, con los nombres reales.
3. **Ver** abre un archivo con su programa habitual a partir de una copia descifrada temporal, que se borra al cerrar la ventana (si un programa aún la tiene abierta, se pide cerrarlo).
4. **Sacar…** guarda lo elegido (un archivo, una carpeta o todo), descifrado y verificado, en la carpeta que se elija, con su fecha original. No reemplaza nada: si ya existe, guarda «nombre (2)». No deja guardar dentro del propio backup.

Al cerrar la ventana todo queda cifrado otra vez: en el disco nunca hay nada descifrado, así que no hace falta «bloquearlo»; basta con cerrar la ventana (o la app) y quitar el disco.

Desde la consola, para recuperar todo de una vez: `powershell -ExecutionPolicy Bypass -File Recuperar-KopiaDesk.ps1 -Accion Recuperar -Destino D:\Recuperado` (opcional `-Carpeta Fotos`).

Si un PC de empresa bloquea PowerShell, el programa del disco no abre: ahí hay que usar Kopia Desk.

### Formato (`lib/cifrado.js`, `lib/almacen.js`, `lib/Recuperar-KopiaDesk.ps1`)

- **Algoritmos:** AES-256-CBC con PKCS7 + HMAC-SHA256 (cifrar y luego firmar) y PBKDF2-SHA256 con 600.000 vueltas para la contraseña (recomendación de OWASP). No son los más modernos (AES-GCM, Argon2), pero son los que trae el PowerShell 5.1 de cualquier Windows 10/11, y eso es lo que permite abrir el backup sin instalar nada.
- **Claves:** una clave maestra al azar de 32 bytes, que nunca se guarda en claro. `cifrado.json` la guarda envuelta dos veces: con la contraseña y con la clave de recuperación (160 bits al azar). Cambiar la contraseña sólo vuelve a envolverla: no hay que recifrar nada y la clave de recuperación sigue sirviendo. De la maestra salen tres subclaves (cifrar, firmar y nombres).
- **Archivo cifrado:** `KDC1` | IV (16) | datos cifrados | HMAC (32), por bloques de 4 MB. Antes de descifrar se comprueba la firma del archivo entero: un solo byte cambiado y se rechaza, sin entregar nada.
- **Nombres opacos:** HMAC de la ruta lógica (`<carpeta>/<ruta dentro>`). La misma ruta da siempre el mismo nombre, así que la app y el script encuentran cada archivo sin guardar ninguna lista en claro.
- **Velocidad:** en una USB Windows escribe sin caché ("extracción rápida"), y agrandar el archivo en cada bloque obliga a actualizar la tabla del disco una y otra vez. Por eso el archivo cifrado se reserva con su tamaño final, se escribe en bloques de 16 MB y, mientras un bloque se escribe, se lee y cifra el siguiente; la verificación lee el archivo una sola vez. Medido en una USB NTFS con archivos de 64 MB: la copia cifrada pasó de 1,4 MB/s a la velocidad de la copia normal. La estimación de tiempo guarda aparte la velocidad de las copias cifradas.
- **Copia verificada igual que sin cifrar:** cifrado a un temporal, comprobación de que el origen no cambió, verificación descifrando lo escrito, y rename. Deduplicación con enlaces, versiones anteriores enlazadas (o copiadas en exFAT/FAT32) sin descifrar, restauración que compara el SHA-256 con el del manifiesto.
- **FAT32:** el límite de 4 GB cuenta los 68 bytes que añade el cifrado.

### Protección del disco del sistema y cambios de disco

**Expulsar** nunca se ofrece para el disco donde está instalado Windows ni para un disco cuyo disco físico no se pudo averiguar, y antes de expulsar se relee la lista de discos para comprobar que la letra sigue siendo el mismo volumen (`checkDriveTarget`). Durante un backup, `driveIdentityChanged` detiene la copia si el USB se cambió por otro con la misma letra.

### Unidades de VeraCrypt

Una unidad montada con VeraCrypt se reconoce como destino («cifrado con VeraCrypt»; sin Expulsar, se desmonta en VeraCrypt). Windows no lista esas unidades con `Get-Volume`, así que se buscan entre las que faltan y se aceptan sólo si su dispositivo es de VeraCrypt (`\Device\VeraCryptVolumeX`); su identidad es `veracrypt:` + el número de serie del volumen.

---

## Problemas conocidos

Detectados en revisión de `main.js` y `lib/core.js`. Ordenados por riesgo para datos ya respaldados. **Los seis están corregidos**; se conservan aquí con su arreglo porque explican decisiones del código.

### 1. Índice de dedup obsoleto puede enlazar contenido equivocado

**Riesgo: alto (corrupción silenciosa). Solo con dedup activado. ✅ Corregido.**

`content-index.json` guardaba `hash -> ruta` y nunca olvidaba entradas: si el archivo en esa ruta cambiaba, el hash viejo seguía apuntando ahí, y `linkTo()` solo comprobaba que la ruta existiera.

Escenario: A contiene X (índice: X -> A). A cambia a Y y se recopia (índice sigue con X -> A). Aparece B con contenido X: se enlazaba a A, que ahora contiene Y. B quedaba respaldado con contenido equivocado.

**Arreglo aplicado:** `ContentIndex` mantiene también el índice inverso ruta -> hashes; toda escritura sobre una ruta (copia o enlace, con o sin dedup activado) olvida los hashes que apuntaban a ella. Antes de enlazar se verifica el tamaño y el SHA-256 completo del archivo indexado; si no coincide, se descarta la entrada y se copia. Índices escritos por versiones anteriores (`hash -> "ruta"`) se siguen leyendo y quedan protegidos por esa verificación. Test: *"problema 1: A con X, A cambia a Y, aparece B con X"*.

### 2. Sobrescribir un archivo enlazado puede alterar sus copias

**Riesgo: alto. ✅ Corregido.**

`copyOneTask` hacía `copyFile` sobre un destino que podía ser un hardlink compartido, modificando el contenido de todos los enlaces a la vez. La v2 lo mitigó borrando antes de copiar (`copyFileReplacing`), pero un corte entre ambos pasos dejaba el destino borrado.

**Arreglo aplicado:** copia siempre a un temporal en la misma carpeta y `rename` sobre el destino (`copyFileVerified`). Eso rompe el enlace sin tocar el contenido compartido y además hace la escritura atómica. Test: *"problema 2: sobrescribir un archivo enlazado no cambia el contenido de sus enlaces"*.

### 3. El hash rápido decide qué no se copia

**Riesgo: medio-alto para ciertos tipos de archivo. ✅ Corregido.**

Si cambiaba la fecha pero el hash de cabecera+cola (64 KB + 64 KB + tamaño) coincidía, el archivo se consideraba sin cambios. Archivos editados en el medio conservando tamaño quedaban sin respaldar: bases de datos (SQLite, Access), `.pst`/`.ost` de Outlook, discos virtuales (`.vhdx`, `.vmdk`), contenedores cifrados, algunos formatos de Office.

**Arreglo aplicado:** si la fecha cambió y el tamaño no, se calcula el SHA-256 completo y se compara con el guardado en el manifiesto. El SHA-256 de cada archivo copiado lo calcula la propia copia verificada y se guarda en el manifiesto, así que no hay lecturas extra. Con manifiestos de versiones anteriores (sin SHA-256) esos archivos se recopian una sola vez. Verificado en la app con un archivo de 1 MB editado en el medio.

### 4. Escrituras no atómicas en archivos críticos

**Riesgo: medio. ✅ Corregido.**

`manifest:save`, `saveContentIndex`, `sources:remember` y `settings:save` usaban `writeFileSync` directo; un corte dejaba un JSON truncado y `manifest:load` devolvía `{}` en silencio.

**Arreglo aplicado:** todas esas escrituras (y los logs) pasan por `atomicWriteFileSync`: `archivo.kopia-tmp`, `fsync`, `rename`. Al cargar un manifiesto dañado se usa `.prev.json` y se avisa en el registro; si tampoco sirve, también se avisa. `.prev.json` solo se actualiza desde un manifiesto que se pudo leer, así un principal dañado nunca pisa el último respaldo bueno. Verificado en la app truncando un manifiesto en la USB.

### 5. La limpieza del journal puede borrar la única copia buena

**Riesgo: medio. ✅ Corregido.**

Si un archivo cambiado estaba a medio sobrescribir al cortarse, `checkJournals` lo borraba, y sin versionado no quedaba ni la versión anterior ni la nueva.

**Arreglo aplicado:** con la copia a temporal + `rename`, lo que queda a medias es el `.kopia-tmp`. Los journals nuevos (`version: 2`) solo borran esos temporales y nunca tocan el destino. Los journals de versiones anteriores mantienen el comportamiento viejo, porque ahí el destino sí podía estar truncado. Test: *"problema 5: la única copia buena no debe borrarse"*; verificado en la app matando el proceso a mitad de copia.

### 6. Los handlers IPC confían en rutas enviadas por el renderer

**Riesgo: bajo en la práctica, importante como principio. ✅ Corregido.**

**Arreglo aplicado:** el proceso principal lleva listas de rutas autorizadas y rechaza todo lo demás:

- Discos destino: solo los devueltos por `listDrives`.
- Orígenes (`fs:scan-directory`, `fs:hash-file`, tareas de copia): solo carpetas elegidas por diálogo, accesos rápidos, o guardadas en la configuración (que a su vez solo guarda orígenes autorizados).
- Destinos de copia: dentro de `KopiaDesk_Backup` y fuera de `.kopia-data`; versiones solo dentro de `.kopia-data\versions`.
- Restauración: `backupFullPath` dentro de `<disco>\KopiaDesk_Backup` y carpeta de destino elegida por diálogo.
- Las rutas de `sources.json` del disco solo sirven para listar nombres y tamaños en Comparar, no para leer contenido.

Verificado en la app: pedir el hash de `C:\Windows\win.ini`, escanear `C:\Windows`, usar un disco inexistente o restaurar a una carpeta no elegida se rechaza.

---

## Limitaciones

- **Sin archivos en uso.** Los bloqueos de milisegundos se superan con reintentos, pero un archivo que sigue abierto (Outlook, bases de datos activas) falla con un mensaje claro ("Archivo en uso por otro programa"), conserva en el backup su versión anterior y se reintenta en el próximo backup. No se usa Volume Shadow Copy.
- **Sin programación.** Los backups son manuales.
- **Sin interfaz para restaurar versiones anteriores.** Existen como `.gz` en una carpeta oculta.
- **Sin retención.** Los archivos eliminados del origen y las versiones anteriores se acumulan para siempre.
- **Un solo destino por ejecución.** No cubre por sí sola la regla 3-2-1.
- **Solo Windows.** Usa PowerShell, `attrib` y rutas de Windows.
- **Sin auto-actualización.** Las correcciones de seguridad de Electron solo llegan reinstalando.
- **Rapidez de la interfaz.** Las consultas a Windows (lista de discos, tipo de disco) usan un PowerShell que queda abierto: detectar discos pasó de ~1,7 s a ~0,25 s, y elegir un disco muestra su tipo en 0,03–0,16 s. Al abrir la app, la lista de discos está lista a los ~1,75 s. Al escanear, los SHA-256 de archivos con la fecha cambiada se calculan varios a la vez en discos SSD (medido: de 119 a 182 MB/s); en discos mecánicos, de a uno.
- **Velocidad frente a Windows** (robocopy, con el mismo vaciado de caché al final), medida en dos USB reales (NTFS y exFAT) con 3 archivos de 256 MB y con 2.000 archivos de 4–64 KB:

  | | Archivos grandes | 2.000 pequeños |
  |---|---|---|
  | **Backup** | 94–100 % de la velocidad de Windows | 70–103 % |
  | **Restaurar** | 84 % | 115–145 % (más rápido que Windows) |

  La diferencia que queda es la verificación: cada archivo se fuerza a disco y se relee para comparar su SHA-256, cosa que Windows no hace. Con muchos archivos pequeños la app mide sola si le conviene copiar 1 o 2 a la vez en ese disco. Algunas USB tienen frenazos propios (de 7 a 22 s cada tanto, con cualquier programa), así que los tiempos varían de una corrida a otra.

---

## Consideraciones técnicas

### Integridad de datos

- ✅ **Verificación post-copia** por SHA-256, siempre activa. *Alcance real:* relee el temporal recién escrito, y Windows suele servir esa lectura desde su caché en memoria. Detecta errores de la copia (lectura del origen, escritura interrumpida, archivo cambiado a mitad), pero **no garantiza** que el medio físico haya guardado bien los datos: para eso hace falta la verificación periódica del punto siguiente, idealmente tras desconectar y reconectar el disco.
- **Verificación periódica del backup** contra el manifiesto por hash, no solo por existencia, para detectar degradación del medio. Pendiente (el manifiesto ya guarda el SHA-256 necesario).
- ✅ **Archivos modificados durante la copia:** si tamaño o fecha cambian mientras se copia, la copia se descarta y el archivo queda para el próximo backup.
- ✅ **Reporte de lo que quedó fuera:** bloqueados, excluidos, enlaces simbólicos, errores de permisos, demasiado grandes para FAT32.

### Windows y sistemas de archivos (a probar)

- ✅ **FAT32:** límite de 4 GB por archivo. Se detecta el sistema de archivos del destino y se avisa antes de copiar.
- ✅ **exFAT y FAT32:** sin hardlinks (el dedup cae a copia normal, verificado en un USB exFAT) y sin journaling (se avisa al elegir el disco).
- **Resolución de fecha en FAT:** 2 segundos. Puede generar falsos "cambiados" (ahora se resuelven por SHA-256 sin recopiar) o no detectar cambios rápidos (la verificación profunda los detecta).
- **NTFS:** límite de 1023 hardlinks por archivo. El fallback a copia ya lo cubre.
- **Rutas mayores a 260 caracteres.**
- **Nombres problemáticos:** Unicode, emojis, espacios o puntos al final, nombres reservados (`CON`, `NUL`, `COM1`).
- **OneDrive "archivos a petición":** hashear o copiar un marcador fuerza la descarga desde la nube. En una carpeta Documentos sincronizada puede significar gigas descargados sin aviso. Detectar el atributo de marcador y advertir.
- ✅ **Junctions y enlaces simbólicos:** el escaneo los ignora (evita bucles) y ahora se informan como "Omitidos".
- ✅ **Archivos `.asar`:** Electron trata los `.asar` como carpetas en su `fs`; la app usa `original-fs` para poder respaldarlos (encontrado al respaldar una carpeta con otra app Electron dentro).
- **Cambio de letra de unidad del USB:** los manifiestos son relativos al destino; verificar que `sources.json` siga funcionando.
- **Renombrado automático de carpetas con el mismo nombre:** verificar qué pasa si cambia el orden o se quita una.
- **Metadatos no copiados:** ACLs, flujos de datos alternos (ADS), atributos (incluido sólo lectura).
- ✅ **Preservación de fechas** al copiar y al restaurar.
- **Suspensión o hibernación** del equipo durante un backup largo.
- ✅ **Dos instancias de la app en el mismo equipo:** resuelto con instancia única (`requestSingleInstanceLock`). Pendiente: dos equipos usando el mismo disco a la vez (un archivo lock en `.kopia-data`).

### Restauración

- **Conflictos:** en la restauración completa, un archivo existente en el destino se reemplaza (de forma atómica). Definir si sobrescribe, omite o pregunta.
- ✅ **Verificación de hash** tras restaurar.
- **Interfaz para versiones anteriores**, con lista por fecha y restauración a una carpeta elegida.
- ✅ **Restauración sin la app** de un backup cifrado: Abrir-KopiaDesk.cmd y `LEEME-CIFRADO.txt` en el propio disco.

### Retención y espacio

- Política de purga configurable para eliminados y versiones (por antigüedad o cantidad).
- Mostrar cuánto ocupan versiones y eliminados.
- El cálculo de espacio libre debe incluir versiones comprimidas y margen para temporales (mientras se copia un archivo cambiado conviven el temporal y la versión anterior).
- Rotación de logs y journals viejos.

### Operación

- Recordatorio "último backup hace X días" o integración con el Programador de tareas de Windows.
- Soporte para un segundo destino o recordatorio de la regla 3-2-1.
- Manejo claro de la desconexión del USB a mitad de backup (interfaz, no solo journal).
- Sugerir expulsar el disco al terminar.

---

## Seguridad

### Estado actual (verificado en el código)

- `contextIsolation: true`, `nodeIntegration: false` y **`sandbox: true` explícito**. El preload expone solo funciones puntuales vía `contextBridge`.
- **Content Security Policy** en `renderer/index.html`:
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'">
  ```
- **Navegación y ventanas nuevas bloqueadas:** `setWindowOpenHandler(() => ({ action: "deny" }))` y `will-navigate` cancelado.
- **Rutas validadas en el proceso principal** (problema 6).
- `safePath()` y `safeBackupPath()` impiden escribir fuera del destino y de `KopiaDesk_Backup`; `safeName()` sanitiza nombres.
- `execFile` en vez de `exec`, sin shell. La letra de unidad se valida antes de interpolarla en PowerShell.
- Límite de tamaño y validación de tipo al leer manifiestos para restaurar.
- Los nombres de archivo se muestran con `textContent`, nunca con `innerHTML`.

### Pendiente

- **`npm audit`** antes de cada release. Hoy informa 6 vulnerabilidades altas (`@xmldom/xmldom`, `brace-expansion`, `fast-uri`, `js-yaml`, `tar`, `undici`), todas dentro de `electron-builder`: afectan a la máquina que compila el instalador, no a la app instalada, que no tiene dependencias en tiempo de ejecución. Actualizar `electron-builder` cuando haya versión corregida.
- **Firma de código** del instalador NSIS, para evitar SmartScreen y garantizar integridad.
- **Canal de actualización** definido (releases de GitHub firmados como mínimo).
- **Privacidad de metadatos:** sin cifrar, `sources.json` y los logs contienen rutas completas con nombre de usuario. Con las copias cifradas van cifrados (la app lo advierte y permite cifrarlas).
- **Ransomware:** un USB conectado siempre se cifra junto con el equipo. La app debería sugerir desconectarlo al terminar.

---

## Plan de pruebas

Además de los tests de `lib/core.js`. ✅ = automatizado en `npm test`; 🔌 = verificado en la app real contra un USB exFAT (Windows 11 Pro).

**Integridad**
- ✅ Escenario del problema 1: A con X, A cambia a Y, aparece B con X. B debe terminar con X.
- ✅ Escenario del problema 2: sobrescribir un archivo que es hardlink y verificar que sus enlaces no cambien.
- 🔌 Archivo editado en el medio con mismo tamaño y fecha nueva (problema 3).
- 🔌 Corte simulado (matar el proceso) durante la copia. Pendiente: durante `manifest:save` y `saveContentIndex` (cubiertos por la escritura atómica, ✅ test de `.prev.json`).
- Desconexión del USB a mitad de copia.

**Sistemas de archivos**
- Destino FAT32 con archivo de 5 GB (✅ lógica del límite; falta la prueba con disco real).
- 🔌 Destino exFAT con dedup activado.
- Rutas de más de 260 caracteres y nombres con Unicode.
- Carpeta de OneDrive con archivos solo en la nube.

**Restauración**
- 🔌 Restauración completa y comparación de hashes contra el origen (en el mismo perfil; falta en otro perfil de Windows).
- Restauración de un archivo eliminado hace varios backups.
- Recuperación manual de una versión `.gz`.

**Rendimiento**
- 100.000 archivos pequeños (tiempo y memoria del manifiesto JSON).
- Archivos individuales de más de 10 GB.

**Cifrado** (✅ = `npm test`)
- ✅ La caja se abre con la contraseña (con tildes, eñes y €) y con la clave de recuperación (también en minúsculas y sin guiones); otra contraseña u otra clave no. Cambiar la contraseña no cambia la clave de recuperación.
- ✅ Archivos de 0 bytes a 9 MB (varios bloques) se cifran y descifran idénticos; un byte cambiado se rechaza sin dejar nada escrito.
- ✅ PowerShell 5.1 descifra lo que cifró Node byte a byte y calcula los mismos nombres opacos.
- ✅ Backup cifrado de punta a punta: en el disco no aparece ningún nombre de archivo o carpeta ni contenido en claro; deduplicación con enlaces; versión anterior intacta tras sobrescribir; restauración con fecha original; manifiesto dañado rescatado con su `.prev`.
- ✅ **Sin la app** (`test/recuperar.test.js`, con el script copiado en el disco): recupera todo con nombres difíciles (tildes, apóstrofo, corchetes, &, %, emoji), rutas de más de 260 caracteres, un archivo de 9 MB y uno vacío, con sus fechas; con la clave de recuperación y desde la raíz del disco; sólo una carpeta; una contraseña equivocada no recupera nada; un archivo alterado o borrado se informa y los demás se recuperan; no pisa lo que ya existe.
- ✅ Rendimiento del script con 50.000 archivos: abrir 0,1 s, leer el catálogo 0,6 s, nombres opacos 6 s.
- ✅ FAT32: el límite de 4 GB cuenta lo que añade el cifrado.
- Pendiente (con la app real, sobre una USB de pruebas y un disco virtual FAT32): cifrar desde el panel, backup, cerrar y abrir, cambiar la contraseña, restaurar; la ventana de Abrir-KopiaDesk.cmd (Ver, Sacar, Detener, cerrar con un archivo abierto) en este PC y en otro con Windows Home.
- ✅ `test/disco-sistema.test.js`: 9 escenarios de disco del sistema y cambios de disco antes de expulsar.
- 🔌 **Expulsar** con un USB real: con un archivo abierto en el USB, Windows lo impide y la app explica el motivo; sin nada abierto, se expulsa en menos de un segundo y la letra desaparece. Un disco virtual (no extraíble) no se expulsa.

---

## Hoja de ruta

Ordenada por prioridad.

**Crítico (antes de usar con datos reales)**
1. ✅ Copia a temporal + `rename` (resuelve problemas 2 y 5).
2. ✅ Corregir invalidación del índice de dedup (problema 1).
3. ✅ Escrituras atómicas y fallback a `.prev.json` (problema 4).
4. ✅ Hash completo cuando cambia la fecha (problema 3).
5. ✅ Verificación post-copia por defecto.

**Alto**
6. ✅ Cifrado del disco destino, fase 1 (detección y advertencia).
7. ✅ Validación de rutas en el proceso principal (problema 6).
8. ✅ CSP, `sandbox: true` y bloqueo de navegación.
9. ✅ Detección de FAT32 y archivos mayores a 4 GB.
10. ✅ Reporte de archivos omitidos o bloqueados.

**Medio**
11. ✅ Cifrado del disco destino, fases 2 y 3 (cifrar, desbloquear y bloquear desde la app).
12. Interfaz para restaurar versiones anteriores.
13. Política de retención.
14. Manejo de conflictos al restaurar.
15. Advertencia de OneDrive archivos a petición.
16. Firma de código e instalador.

**Bajo**
17. Recordatorios o programación.
18. Segundo destino.
19. Volume Shadow Copy para archivos en uso.

---

## Recomendaciones para quien usa la app

- **Cifra el disco de backup.** Si el USB se pierde sin cifrar, cualquiera puede leerlo.
- **Si cifras las copias, guarda la clave de recuperación fuera del USB**: en papel o en un gestor de contraseñas. Sin contraseña ni clave de recuperación, los datos son irrecuperables.
- **Desconecta el disco cuando termines.** Un disco conectado siempre queda expuesto a ransomware.
- **Ten más de una copia.** Idealmente tres copias, en dos medios distintos, con una fuera de casa u oficina.
- **Prueba restaurar** de vez en cuando. Un backup que nunca se restauró es una suposición.
- **Cierra Outlook y programas con bases de datos** antes de respaldar.
- **Prefiere NTFS** para el disco de backup: admite archivos grandes, hardlinks (dedup) y tiene journaling.

---

## Stack

- Electron (proceso principal + renderer aislado y en sandbox con `contextBridge`)
- Node.js (`fs`/`original-fs`, `crypto`, `zlib`, `child_process`)
- HTML/CSS/JS sin frameworks
- `node --test` para la suite de `lib/core.js`
- PowerShell: módulo `Storage` para los discos; PowerShell 5.1 (.NET: AES, HMAC, PBKDF2 y WinForms) en `lib/Recuperar-KopiaDesk.ps1`, el programa que abre las copias cifradas sin la app

---

## Licencia

MIT

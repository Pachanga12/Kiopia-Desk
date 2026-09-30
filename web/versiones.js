"use strict";
// Historia de Kopia Desk (sale de la colección de Música: Kopia Desk - funcionamiento).
window.KD_VERSIONES = [
  {
    "v": "V0.1",
    "nombre": "Web + andamiaje Electron",
    "fecha": "27-06-2026",
    "tipo": "Web (sólo navegador) + primer esqueleto Electron",
    "resumen": "El primer Kopia Desk: una página que hace copias incrementales de tus carpetas sólo con el navegador, y el primer esqueleto de lo que sería la app de escritorio.",
    "puntos": [
      "Añadir una o varias carpetas de origen.",
      "Elegir una carpeta de destino (por ejemplo, la raíz de un USB).",
      "Escanea las carpetas completas, con subcarpetas.",
      "Compara con el último escaneo (el «manifiesto»: lista de archivos con tamaño y fecha) y separa los archivos en nuevos, cambiados y eliminados."
    ]
  },
  {
    "v": "V0.2",
    "nombre": "Web con servidor Python",
    "fecha": "27-06-2026",
    "tipo": "Web · navegador + servidor Python",
    "resumen": "El mismo día, la versión web gana un pequeño servidor Python que ve los discos y escribe la copia. Es la línea que siguen V0.3, V0.4 y V0.5.",
    "puntos": [
      "Servidor Python propio (server.py): se abre con iniciar-kopia-desk.bat y se usa en http://127.0.0.1:4178 desde Chrome o Edge.",
      "Lista de discos conectados con su nombre y el espacio libre real, para elegir dónde guardar (lo que el navegador solo no podía).",
      "El backup lo escribe el servidor directamente en el disco elegido: <disco>\\AlfombraBackup\\<carpeta>\\latest, con _versions y _logs como antes.",
      "Por dentro el proyecto pasa a llamarse «kopia-desk»."
    ]
  },
  {
    "v": "V0.3",
    "nombre": "Web Prueba-4",
    "fecha": "28-06-2026",
    "tipo": "Web · navegador + servidor Python",
    "resumen": "Sigue la línea de V0.2 (con servidor Python) y resuelve su mayor problema: el historial ahora se guarda en el propio disco de backup.",
    "puntos": [
      "El manifiesto viaja con el disco: se guarda en AlfombraBackup\\<carpeta>\\_manifests\\manifest.json y al escanear se lee de ahí (nueva función del servidor para leer archivos). Con el mismo USB en otro navegador o equipo, ya sabe qué estaba respaldado.",
      "Copia varios archivos a la vez y deja respirar a la interfaz entre archivo y archivo, para que la página no se congele.",
      "La subida de archivos ya no usa el módulo cgi de Python (lee el formulario con email.parser): funciona en Python moderno.",
      "El servidor anota cada petición en request_log.txt para depurar."
    ]
  },
  {
    "v": "V0.4",
    "nombre": "Web v.1.1",
    "fecha": "28-06-2026",
    "tipo": "Web · navegador + servidor Python",
    "resumen": "Pulido de la V0.3: el backup cambia de nombre y la pantalla dice de dónde salió el historial.",
    "puntos": [
      "La carpeta del backup pasa de AlfombraBackup a KopiaDesk.",
      "Indicador nuevo en la pantalla: «Manifiesto: cargado desde destino (fecha)» o «usando historial local», y el registro dice de dónde se cargó cada carpeta.",
      "El servidor puede devolver también la fecha del manifiesto guardado.",
      "Se quita el registro de peticiones de depuración."
    ]
  },
  {
    "v": "V0.5",
    "nombre": "Web variante local",
    "fecha": "10-07-2026",
    "tipo": "Web · navegador + servidor Python",
    "resumen": "La rama web siguió aparte y se retocó el 10-07, ya después de la Beta_1: más robusta y más discreta.",
    "puntos": [
      "La carpeta del backup pasa a Kopia_Desk (definida en un solo sitio del código).",
      "Si el manifiesto del disco está dañado, usa el historial local en vez de fallar.",
      "Mensajes de error más claros al escribir en el destino (qué carpeta o archivo falló).",
      "El servidor ya no deja registro de peticiones en el disco, y reconoce mejor los formularios de subida."
    ]
  },
  {
    "v": "V0.6",
    "nombre": "Migración a Electron",
    "fecha": "29-06-2026",
    "tipo": "App de escritorio · Electron 35",
    "resumen": "El gran salto: Kopia Desk deja de ser una página web y pasa a ser una app de escritorio de Windows, con su propia ventana e instalador.",
    "puntos": [
      "Sin navegador ni Python: una app con su ventana, que se instala.",
      "Carpetas con el diálogo normal de Windows; lista de discos y USB con su espacio real.",
      "Escaneo con barra de progreso.",
      "Backup en <disco>\\KopiaDesk_Backup\\<carpeta>\\, con los datos internos (manifiestos, versiones y registros) en una carpeta oculta .kopia-data."
    ]
  },
  {
    "v": "V0.7",
    "nombre": "Electron con retoques",
    "fecha": "30-06-2026",
    "tipo": "App de escritorio · Electron 35",
    "resumen": "Retoques visuales sobre la V0.6 y una limpieza del código.",
    "puntos": [
      "El botón Copiar se pone verde cuando se puede copiar.",
      "Contadores de colores: carpetas en azul, cambios en ámbar, copiados en verde.",
      "El espacio del disco muestra también el % usado.",
      "El registro muestra la hora destacada; las carpetas se quitan con «×»; efectos al pasar el ratón; título más compacto."
    ]
  },
  {
    "v": "V1.0",
    "nombre": "Beta_1",
    "fecha": "01/02-07-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "La primera versión completa y probada: la base de todo lo que vino después.",
    "puntos": [
      "Núcleo separado (lib/core.js) con 31 tests automáticos y CI en GitHub.",
      "El escaneo ya no congela la ventana.",
      "Accesos rápidos a Imágenes, Documentos, Descargas, Música, Videos y Escritorio. Si dos carpetas se llaman igual, la segunda se renombra sola para no mezclar backups.",
      "Exclusiones configurables (Thumbs.db, .git, node_modules, *.tmp…)."
    ]
  },
  {
    "v": "V2.0",
    "nombre": "Kopia Desk v2",
    "fecha": "27-09-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "Una versión nueva de verdad: diseño nuevo, copia que no puede quedar a medias, cifrado del disco con BitLocker y un repaso completo de seguridad.",
    "puntos": [
      "Nuevo nombre y diseño («Kopia Desk v2»): tema claro y oscuro, ventana sin marco, icono nuevo.",
      "Copia atómica y verificada: cada archivo se copia a un temporal, se compara su SHA-256 con el original y sólo entonces reemplaza al anterior. Un corte nunca deja un archivo del backup roto.",
      "El historial sólo apunta lo que se copió y verificó; lo que falló vuelve a salir en el próximo escaneo.",
      "Si sólo cambió la fecha, se compara el SHA-256 completo (el hash rápido ya no decide nada)."
    ]
  },
  {
    "v": "V2.1",
    "nombre": "",
    "fecha": "27-09-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "Robustez y detalles de ventana.",
    "puntos": [
      "Reintentos: si un archivo está bloqueado un instante (antivirus, Office), lo reintenta sin tocar la copia que ya estaba en el backup.",
      "Una sola ventana: abrir la app dos veces trae la que ya está abierta (evita que dos copias se pisen).",
      "Estilos sin «inline»: se arreglan los márgenes que faltaban en la V2.0.",
      "El tema sigue al de Windows y la ventana se adapta a pantallas pequeñas."
    ]
  },
  {
    "v": "V2.2",
    "nombre": "",
    "fecha": "27-09-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "Integridad del backup: se cierran los últimos huecos.",
    "puntos": [
      "El journal protege también las versiones anteriores si se corta la copia.",
      "Índice de deduplicación que se actualiza por partes (más rápido y seguro).",
      "Restauración verificada: cada archivo restaurado se compara con el SHA-256 guardado; si el backup está dañado, lo avisa en vez de restaurar algo roto.",
      "Protección de identidad del disco: si cambias el USB por otro con la misma letra a mitad de una copia, se detiene."
    ]
  },
  {
    "v": "V2.3",
    "nombre": "",
    "fecha": "27-09-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "Publicación de la V2.2 con otro número.",
    "puntos": [
      "El código de la app es el mismo: sólo cambian el número de versión (2.3.0), los enlaces al repositorio y el contador de tests."
    ]
  },
  {
    "v": "V2.4",
    "nombre": "",
    "fecha": "29-09-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "Comodidad y velocidad: saber cuánto tarda, poder parar, elegir qué no copiar y no cerrarla sin querer.",
    "puntos": [
      "Detener: para la copia terminando y verificando el archivo en curso; lo que falta se copia la próxima vez.",
      "Tiempo: antes de copiar, «Tardará unos 4 min» (con la velocidad medida en ese disco); durante, «Lleva 1:23 · quedan ~3 min · 25 MB/s».",
      "Más rápida: copia nativa de Windows con verificación, varios archivos a la vez en las USB que lo aguantan, restauración en una sola lectura y escaneo con varios hashes a la vez.",
      "La comprobación de que el disco sigue siendo el mismo ya no espera a Windows (antes podía tardar hasta 28 s con la USB ocupada)."
    ]
  },
  {
    "v": "V3.0",
    "nombre": "La actual",
    "fecha": "30-09-2026",
    "tipo": "App de escritorio · Electron 43",
    "resumen": "Copias cifradas propias que se abren en cualquier Windows, con o sin la app.",
    "puntos": [
      "BitLocker no existe en Windows Home, y una USB cifrada desde Home no se podía abrir en otro equipo. Ahora Kopia Desk cifra las copias ella misma (AES-256): funciona en cualquier Windows y en cualquier USB (FAT32, exFAT o NTFS), sin permisos de administrador.",
      "Se cifra el contenido y también los nombres de archivos y carpetas: en la USB sólo se ven nombres sin sentido como datos\\3f\\9a1c….kdc.",
      "Se activa en el panel del disco con una contraseña. Kopia Desk muestra una sola vez la clave de recuperación y no deja seguir hasta confirmar que se guardó fuera de la USB.",
      "Para copiar o restaurar se abre con la contraseña (o la clave); Cerrar ahora y Cambiar contraseña… están en el mismo panel."
    ]
  }
];

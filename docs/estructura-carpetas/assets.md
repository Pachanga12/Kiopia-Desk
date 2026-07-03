# Carpeta `assets/`

Contiene únicamente `Kopia_Desk.png`, el icono de la aplicación. Se usa en dos
lugares:

- `main.js` lo carga como icono de la ventana (`BrowserWindow`).
- `package.json` lo referencia en la configuración de `electron-builder` como
  icono del instalador y del ejecutable final (`dist/Kopia Desk Setup *.exe`).

No hay lógica aquí — si se reemplaza el archivo por otro PNG (idealmente
cuadrado, 256×256 o más), el icono cambia en toda la app sin tocar código.

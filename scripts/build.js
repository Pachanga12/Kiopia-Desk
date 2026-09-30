"use strict";

// Compila Kopia Desk para Windows en dos pasos:
//   1. La versión PORTABLE (un solo .exe que se abre sin instalar), en dist/portable/.
//   2. El INSTALADOR, que lleva dentro esa portable (resources/portable/): la app
//      la copia al disco de backup para abrir las copias en otro PC sin instalar.
// Uso: npm run build   (sin firma: $env:CSC_IDENTITY_AUTO_DISCOVERY="false")

const path = require("path");
const fs = require("fs");
const builder = require("electron-builder");
const pkg = require("../package.json");

const ROOT = path.join(__dirname, "..");
const PORTABLE_NAME = "KopiaDesk-Portable.exe";
const PORTABLE_OUT = path.join(ROOT, "dist", "portable");

async function main() {
  const base = pkg.build;
  const win = builder.Platform.WINDOWS;

  console.log("== 1/2: versión portable");
  await builder.build({
    projectDir: ROOT,
    targets: win.createTarget("portable", builder.Arch.x64),
    publish: "never",
    config: {
      ...base,
      directories: { ...(base.directories || {}), output: PORTABLE_OUT },
      portable: { artifactName: PORTABLE_NAME },
    },
  });
  const portable = path.join(PORTABLE_OUT, PORTABLE_NAME);
  if (!fs.existsSync(portable)) throw new Error("No se generó " + portable);

  console.log("== 2/2: instalador (con la portable dentro)");
  await builder.build({
    projectDir: ROOT,
    targets: win.createTarget("nsis", builder.Arch.x64),
    publish: "never",
    config: {
      ...base,
      extraResources: [{ from: path.relative(ROOT, portable), to: "portable/" + PORTABLE_NAME }],
    },
  });
  console.log("Listo: dist/ (instalador) y dist/portable/" + PORTABLE_NAME);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

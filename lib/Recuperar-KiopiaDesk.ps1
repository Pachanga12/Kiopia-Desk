param(
  # Carpeta KiopiaDesk_Backup del disco (por defecto, la del propio script).
  # También vale la raíz del disco (E:\).
  [string]$Backup = $PSScriptRoot,
  # Recuperar: dónde dejar los archivos descifrados.
  [string]$Destino,
  # Recuperar: sólo esta carpeta del backup (vacío = todas).
  [string]$Carpeta = '',
  # Recuperar: contraseña o clave (sólo para pruebas; si falta, se pregunta).
  [string]$Secreto,
  # Abrir: ventana para ver y sacar archivos (lo normal, con doble clic en
  # Abrir-KiopiaDesk.cmd). Recuperar: todo a una carpeta, desde la consola.
  # Import: sólo cargar las funciones (para los tests).
  [ValidateSet('Abrir', 'Recuperar', 'Import')] [string]$Accion = 'Abrir'
)
# Abre un backup CIFRADO de Kiopia Desk sin Kiopia Desk: con la contraseña o con
# la clave de recuperación, en cualquier Windows 10/11 (también Home), sin
# instalar nada y sin permisos de administrador.
# Mismo formato que lib/cifrado.js y lib/almacen.js (AES-256-CBC + HMAC-SHA256,
# PBKDF2-SHA256): los tests comprueban que los dos se entienden byte a byte.
$ErrorActionPreference = 'Stop'

$KdMagic = [byte[]](0x4B, 0x44, 0x43, 0x31) # "KDC1"
$KdBase32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

# --- Criptografía ------------------------------------------------------------------

function Get-KdWrapKeys([byte[]]$Secret, [byte[]]$Salt, [int]$Iterations) {
  $d = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($Secret, $Salt, $Iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  try { $k = $d.GetBytes(64) } finally { $d.Dispose() }
  return @{ Enc = [byte[]]$k[0..31]; Mac = [byte[]]$k[32..63] }
}

function Get-KdHmac([byte[]]$Key, [byte[][]]$Parts) {
  $h = New-Object System.Security.Cryptography.HMACSHA256 (, $Key)
  try {
    foreach ($p in $Parts) { [void]$h.TransformBlock($p, 0, $p.Length, $null, 0) }
    [void]$h.TransformFinalBlock([byte[]]@(), 0, 0)
    return , [byte[]]$h.Hash
  } finally { $h.Dispose() }
}

function Get-KdSubkeys([byte[]]$MasterKey) {
  $u = [System.Text.Encoding]::UTF8
  return @{
    Enc  = Get-KdHmac $MasterKey @(, $u.GetBytes('kopia-desk:archivo-cifrado'))
    Mac  = Get-KdHmac $MasterKey @(, $u.GetBytes('kopia-desk:archivo-firma'))
    Name = Get-KdHmac $MasterKey @(, $u.GetBytes('kopia-desk:nombre'))
  }
}

function Test-KdSame([byte[]]$A, [byte[]]$B) {
  if ($A.Length -ne $B.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $A.Length; $i++) { $diff = $diff -bor ($A[$i] -bxor $B[$i]) }
  return $diff -eq 0
}

function New-KdAes([byte[]]$Key, [byte[]]$Iv) {
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $Key
  $aes.IV = $Iv
  return $aes
}

function Unprotect-KdWrapped($W, $Keys) {
  $iv = [Convert]::FromBase64String($W.iv)
  $data = [Convert]::FromBase64String($W.datos)
  $mac = Get-KdHmac $Keys.Mac @($iv, $data)
  if (-not (Test-KdSame $mac ([Convert]::FromBase64String($W.mac)))) { return $null }
  $aes = New-KdAes $Keys.Enc $iv
  try { $d = $aes.CreateDecryptor(); $mk = $d.TransformFinalBlock($data, 0, $data.Length) } finally { $aes.Dispose() }
  if ($mk.Length -ne 32) { return $null }
  return , [byte[]]$mk
}

function ConvertFrom-KdRecoveryKey([string]$Text) {
  $clean = ($Text.ToUpperInvariant() -replace '[\s-]', '')
  if ($clean.Length -ne 32) { return $null }
  $bits = New-Object System.Text.StringBuilder
  foreach ($ch in $clean.ToCharArray()) {
    $i = $KdBase32.IndexOf($ch)
    if ($i -lt 0) { return $null }
    [void]$bits.Append([Convert]::ToString($i, 2).PadLeft(5, '0'))
  }
  $b = $bits.ToString()
  $out = New-Object byte[] 20
  for ($i = 0; $i -lt 20; $i++) { $out[$i] = [Convert]::ToByte($b.Substring($i * 8, 8), 2) }
  return , $out
}

# Clave maestra a partir de la contraseña o de la clave de recuperación ($null si no vale).
function Unlock-KdVault($Vault, [string]$Secret) {
  if ($Vault.formato -ne 'kopia-desk-cifrado' -or $Vault.version -ne 1) { throw 'Esto no es una caja de cifrado de Kiopia Desk (cifrado.json).' }
  $rec = ConvertFrom-KdRecoveryKey $Secret
  if ($rec) {
    $r = $Vault.porRecuperacion
    $mk = Unprotect-KdWrapped $r (Get-KdWrapKeys $rec ([Convert]::FromBase64String($r.sal)) ([int]$r.vueltas))
    if ($mk) { return , $mk }
  }
  if (-not $Secret) { return $null }
  $p = $Vault.porContrasena
  $mk = Unprotect-KdWrapped $p (Get-KdWrapKeys ([System.Text.Encoding]::UTF8.GetBytes($Secret)) ([Convert]::FromBase64String($p.sal)) ([int]$p.vueltas))
  if ($mk) { return , $mk }
  return $null
}

# Nombre opaco en el disco (igual que opaqueName de lib/cifrado.js). El HMAC de
# nombres se prepara una vez por clave maestra (con miles de archivos, crearlo
# para cada uno hacía que sacar 50.000 archivos tardara 20 s sólo en nombres).
function Get-KdOpaqueName([byte[]]$MasterKey, [string]$Kind, [string]$LogicalPath) {
  if (-not [object]::ReferenceEquals($script:KdNameFor, $MasterKey)) {
    Clear-KdNameCache
    $script:KdNameHmac = New-Object System.Security.Cryptography.HMACSHA256 (, [byte[]](Get-KdSubkeys $MasterKey).Name)
    $script:KdNameFor = $MasterKey
  }
  $h = $script:KdNameHmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Kind + [char]0 + $LogicalPath))
  $hex = [BitConverter]::ToString($h).Replace('-', '').ToLowerInvariant()
  return $hex.Substring(0, 2) + '/' + $hex.Substring(2, 38) + '.kdc'
}

function Clear-KdNameCache {
  if ($script:KdNameHmac) { $script:KdNameHmac.Dispose() }
  $script:KdNameHmac = $null
  $script:KdNameFor = $null
}

# Descifra un archivo pequeño (manifiesto, índice) a bytes. Comprueba la firma antes.
function Unprotect-KdBytes([byte[]]$MasterKey, [byte[]]$Blob) {
  if ($Blob.Length -lt 68 -or -not (Test-KdSame ([byte[]]$Blob[0..3]) $KdMagic)) { throw 'No es un archivo cifrado de Kiopia Desk.' }
  $k = Get-KdSubkeys $MasterKey
  $iv = [byte[]]$Blob[4..19]
  $body = New-Object byte[] ($Blob.Length - 52)
  [Array]::Copy($Blob, 20, $body, 0, $body.Length)
  $tag = New-Object byte[] 32
  [Array]::Copy($Blob, $Blob.Length - 32, $tag, 0, 32)
  if (-not (Test-KdSame (Get-KdHmac $k.Mac @($KdMagic, $iv, $body)) $tag)) { throw 'El archivo cifrado está dañado o fue alterado.' }
  $aes = New-KdAes $k.Enc $iv
  try { $plain = $aes.CreateDecryptor().TransformFinalBlock($body, 0, $body.Length) } finally { $aes.Dispose() }
  return , [byte[]]$plain
}

function Unprotect-KdJson([byte[]]$MasterKey, [string]$Path) {
  $plain = Unprotect-KdBytes $MasterKey ([System.IO.File]::ReadAllBytes($Path))
  return ([System.Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json)
}

# Igual, pero devuelve un diccionario (más rápido y sin límite de tamaño con
# manifiestos de muchos archivos).
function Unprotect-KdJsonDict([byte[]]$MasterKey, [string]$Path) {
  if (-not $script:KdJson) {
    Add-Type -AssemblyName System.Web.Extensions
    $s = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $s.MaxJsonLength = [int]::MaxValue
    $script:KdJson = $s
  }
  $plain = Unprotect-KdBytes $MasterKey ([System.IO.File]::ReadAllBytes($Path))
  $o = $script:KdJson.DeserializeObject([System.Text.Encoding]::UTF8.GetString($plain))
  return , $o
}

# Descifra un archivo grande a $Dst por bloques: primero comprueba la firma de
# todo el archivo, luego descifra. Devuelve el SHA-256 del contenido original.
# $OnChunk (opcional) se llama con (bytes, 'v'erificando | 'd'escifrando).
function Unprotect-KdFile([byte[]]$MasterKey, [string]$Src, [string]$Dst, [scriptblock]$OnChunk = $null) {
  $k = Get-KdSubkeys $MasterKey
  $in = [System.IO.File]::OpenRead($Src)
  try {
    $size = $in.Length
    if ($size -lt 68) { throw 'No es un archivo cifrado de Kiopia Desk.' }
    $head = New-Object byte[] 20
    [void]$in.Read($head, 0, 20)
    if (-not (Test-KdSame ([byte[]]$head[0..3]) $KdMagic)) { throw 'No es un archivo cifrado de Kiopia Desk.' }
    $bodyEnd = $size - 32
    $h = New-Object System.Security.Cryptography.HMACSHA256 (, $k.Mac)
    [void]$h.TransformBlock($head, 0, 20, $null, 0)
    $buf = New-Object byte[] 4194304
    $pos = 20
    while ($pos -lt $bodyEnd) {
      $n = $in.Read($buf, 0, [int][Math]::Min($buf.Length, $bodyEnd - $pos))
      [void]$h.TransformBlock($buf, 0, $n, $null, 0)
      $pos += $n
      if ($OnChunk) { & $OnChunk $n 'v' }
    }
    [void]$h.TransformFinalBlock([byte[]]@(), 0, 0)
    $tag = New-Object byte[] 32
    [void]$in.Read($tag, 0, 32)
    $good = Test-KdSame $h.Hash $tag
    $h.Dispose()
    if (-not $good) { throw "El archivo cifrado está dañado o fue alterado: $Src" }

    $aes = New-KdAes $k.Enc ([byte[]]$head[4..19])
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $out = New-Object System.IO.FileStream($Dst, [System.IO.FileMode]::CreateNew)
    try {
      $dec = $aes.CreateDecryptor()
      $in.Position = 20
      $pos = 20
      $plain = New-Object byte[] ($buf.Length + 32)
      while ($pos -lt $bodyEnd) {
        $n = $in.Read($buf, 0, [int][Math]::Min($buf.Length, $bodyEnd - $pos))
        $pos += $n
        if ($pos -lt $bodyEnd) {
          $m = $dec.TransformBlock($buf, 0, $n, $plain, 0)
        } else {
          $last = $dec.TransformFinalBlock($buf, 0, $n)
          $m = $last.Length
          [Array]::Copy($last, $plain, $m)
        }
        if ($m -gt 0) { $out.Write($plain, 0, $m); [void]$sha.TransformBlock($plain, 0, $m, $null, 0) }
        if ($OnChunk) { & $OnChunk $n 'd' }
      }
      [void]$sha.TransformFinalBlock([byte[]]@(), 0, 0)
      return [BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant()
    } finally { $out.Dispose(); $aes.Dispose(); $sha.Dispose() }
  } finally { $in.Dispose() }
}

# --- El backup: caja de claves, catálogo y archivos ------------------------------

# Acepta la carpeta KiopiaDesk_Backup o la raíz del disco.
function Resolve-KdBackupRoot([string]$Path) {
  if (-not $Path) { $Path = (Get-Location).Path }
  $Path = [System.IO.Path]::GetFullPath($Path)
  foreach ($c in @($Path, [System.IO.Path]::Combine($Path, 'KiopiaDesk_Backup'))) {
    if ([System.IO.Directory]::Exists([System.IO.Path]::Combine($c, '.kiopia-data'))) { return $c }
  }
  return $Path
}

function Read-KdVault([string]$BackupRoot) {
  foreach ($n in @('cifrado.json', 'cifrado.copia.json')) {
    $p = [System.IO.Path]::Combine($BackupRoot, '.kiopia-data', $n)
    if (-not [System.IO.File]::Exists($p)) { continue }
    try {
      $v = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($v.formato -eq 'kopia-desk-cifrado') { return $v }
    } catch { }
  }
  throw "No se encontró la clave del backup cifrado (.kiopia-data\cifrado.json) en:`n$BackupRoot`n`n¿Es la carpeta KiopiaDesk_Backup de un backup cifrado?"
}

# Campo de un diccionario leído del JSON ($null si no está).
function Get-KdField($Dict, [string]$Key) {
  if ($null -ne $Dict -and $Dict.ContainsKey($Key)) { return $Dict[$Key] }
  return $null
}

# Carpetas respaldadas: @{ Fuentes = [ { Fuente, Carpeta, Archivos } ]; Avisos = [...] }.
# Archivos: diccionario "ruta/dentro" -> { size, hash, lastModified }.
function Get-KdCatalog([byte[]]$MasterKey, [string]$BackupRoot) {
  $dir = [System.IO.Path]::Combine($BackupRoot, '.kiopia-data', 'manifests')
  $fuentes = New-Object System.Collections.ArrayList
  $avisos = New-Object System.Collections.ArrayList
  if ([System.IO.Directory]::Exists($dir)) {
    foreach ($f in [System.IO.Directory]::GetFiles($dir, '*.kdc')) {
      if ($f.EndsWith('.prev.kdc')) { continue }
      $m = $null
      foreach ($p in @($f, ($f -replace '\.kdc$', '.prev.kdc'))) {
        if (-not [System.IO.File]::Exists($p)) { continue }
        try {
          $m = Unprotect-KdJsonDict $MasterKey $p
          if ($p -ne $f) { [void]$avisos.Add("El registro de '$((Get-KdField $m 'fuente'))' estaba dañado: se usó su copia anterior.") }
          break
        } catch { }
      }
      if ($null -eq $m) {
        [void]$avisos.Add("No se pudo leer el registro de una carpeta ($([System.IO.Path]::GetFileName($f))): está dañado.")
        continue
      }
      $arch = (Get-KdField $m 'archivos')
      if ($arch -isnot [System.Collections.IDictionary]) { $arch = @{} }
      [void]$fuentes.Add([pscustomobject]@{ Fuente = [string](Get-KdField $m 'fuente'); Carpeta = [string](Get-KdField $m 'carpeta'); Archivos = $arch })
    }
  }
  return @{ Fuentes = @($fuentes | Sort-Object Fuente); Avisos = @($avisos) }
}

function Get-KdDataPath([byte[]]$MasterKey, [string]$BackupRoot, [string]$Carpeta, [string]$RelPath) {
  $name = Get-KdOpaqueName $MasterKey 'archivo' ($Carpeta + '/' + $RelPath.Replace('\', '/'))
  return [System.IO.Path]::Combine($BackupRoot, 'datos', $name.Replace('/', '\'))
}

# Una ruta del registro que no se pueda escribir tal cual (vacía, "..",
# caracteres que Windows no admite) no se usa nunca para escribir.
function Test-KdSafeRelative([string]$Rel) {
  if (-not $Rel) { return $false }
  foreach ($seg in $Rel.Split('/')) {
    if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..') { return $false }
    if ($seg.IndexOfAny([char[]]'<>:"|?*\') -ge 0) { return $false }
    if ($seg -match '[\x00-\x1f]') { return $false }
  }
  return $true
}

# Rutas de más de 260 caracteres: con el prefijo \\?\ .NET las admite.
function Get-KdIoPath([string]$Path) {
  if ($Path.Length -lt 240 -or $Path.StartsWith('\\?\')) { return $Path }
  if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
  return '\\?\' + $Path
}

# Si ya hay algo con ese nombre no se pisa: "foto (2).jpg", "foto (3).jpg"...
function Get-KdFreeName([string]$Path) {
  $io = Get-KdIoPath $Path
  if (-not [System.IO.File]::Exists($io) -and -not [System.IO.Directory]::Exists($io)) { return $Path }
  $dir = [System.IO.Path]::GetDirectoryName($Path)
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $ext = [System.IO.Path]::GetExtension($Path)
  for ($i = 2; ; $i++) {
    $p = [System.IO.Path]::Combine($dir, "$base ($i)$ext")
    $io = Get-KdIoPath $p
    if (-not [System.IO.File]::Exists($io) -and -not [System.IO.Directory]::Exists($io)) { return $p }
  }
}

# Descifra un archivo del backup a $Target (o a un nombre libre al lado) vía
# temporal: firma comprobada, SHA-256 igual al del registro y fecha original.
# Devuelve la ruta final.
function Restore-KdEntry([byte[]]$MasterKey, [string]$Blob, [string]$Target, $Entry, [scriptblock]$OnChunk = $null) {
  [void][System.IO.Directory]::CreateDirectory((Get-KdIoPath ([System.IO.Path]::GetDirectoryName($Target))))
  $final = Get-KdFreeName $Target
  $ioTmp = Get-KdIoPath ($final + '.kiopia-tmp')
  if ([System.IO.File]::Exists($ioTmp)) { [System.IO.File]::Delete($ioTmp) }
  try {
    $hash = Unprotect-KdFile $MasterKey $Blob $ioTmp $OnChunk
    $expected = [string](Get-KdField $Entry 'hash')
    if ($expected -and $hash -ne $expected) { throw 'El archivo del backup no coincide con su registro (posible daño en el disco).' }
    $lm = (Get-KdField $Entry 'lastModified')
    if ($lm) { [System.IO.File]::SetLastWriteTimeUtc($ioTmp, [DateTimeOffset]::FromUnixTimeMilliseconds([long][double]$lm).UtcDateTime) }
    [System.IO.File]::Move($ioTmp, (Get-KdIoPath $final))
    return $final
  } catch {
    if ([System.IO.File]::Exists($ioTmp)) { [System.IO.File]::Delete($ioTmp) }
    throw
  }
}

# $Items: lista de @{ Carpeta; Rel; Entry; Target }. Sigue con los demás si uno
# falla. Devuelve @{ Ok; Fallidos = ["ruta: motivo"]; Faltan }. Para cancelar,
# $OnFile u $OnChunk lanzan 'KD-CANCEL'.
function Export-KdItems([byte[]]$MasterKey, [string]$BackupRoot, $Items, [scriptblock]$OnFile = $null, [scriptblock]$OnChunk = $null) {
  $ok = 0
  $missing = 0
  $fail = New-Object System.Collections.ArrayList
  foreach ($it in $Items) {
    if ($OnFile) { & $OnFile $it }
    $shown = $it.Carpeta + '/' + $it.Rel
    if (-not (Test-KdSafeRelative $it.Rel) -or -not (Test-KdSafeRelative $it.Carpeta) -or $it.Carpeta.Contains('/')) {
      [void]$fail.Add("${shown}: nombre no válido")
      continue
    }
    $blob = Get-KdDataPath $MasterKey $BackupRoot $it.Carpeta $it.Rel
    if (-not [System.IO.File]::Exists($blob)) {
      $missing++
      [void]$fail.Add("${shown}: no está en el disco de backup")
      continue
    }
    try {
      [void](Restore-KdEntry $MasterKey $blob $it.Target $it.Entry $OnChunk)
      $ok++
    } catch {
      if ($_.Exception.Message -eq 'KD-CANCEL') { throw }
      [void]$fail.Add("${shown}: $($_.Exception.Message)")
    }
  }
  return @{ Ok = $ok; Fallidos = @($fail); Faltan = $missing }
}

# Todos los archivos de una carpeta respaldada (o de una subcarpeta, con
# $Prefix "a/b"), con su destino dentro de $DestBase.
function Get-KdItems($Source, [string]$Prefix, [string]$DestBase) {
  $list = New-Object System.Collections.ArrayList
  $start = if ($Prefix) { $Prefix + '/' } else { '' }
  foreach ($k in $Source.Archivos.Keys) {
    if ($start -and -not $k.StartsWith($start, [StringComparison]::Ordinal)) { continue }
    $rest = $k.Substring($start.Length)
    [void]$list.Add(@{ Carpeta = $Source.Carpeta; Rel = $k; Entry = $Source.Archivos[$k]; Target = [System.IO.Path]::Combine($DestBase, $rest.Replace('/', '\')) })
  }
  return , $list
}

# Recupera todo (o una carpeta) a $Dest\<carpeta>\... Para la consola y los tests.
function Invoke-KdRecover([string]$BackupRoot, [string]$Secret, [string]$Dest, [string]$Only = '') {
  $mk = Unlock-KdVault (Read-KdVault $BackupRoot) $Secret
  if (-not $mk) { throw 'La contraseña o la clave de recuperación no es correcta.' }
  try {
    $cat = Get-KdCatalog $mk $BackupRoot
    $items = New-Object System.Collections.ArrayList
    foreach ($s in $cat.Fuentes) {
      if ($Only -and $s.Fuente -ne $Only -and $s.Carpeta -ne $Only) { continue }
      $items.AddRange((Get-KdItems $s '' ([System.IO.Path]::Combine($Dest, $s.Carpeta))))
    }
    $r = Export-KdItems $mk $BackupRoot $items
    $r.Total = $items.Count
    $r.Avisos = $cat.Avisos
    return $r
  } finally { Clear-KdNameCache; [Array]::Clear($mk, 0, $mk.Length) }
}

function Format-KdSize([double]$Bytes) {
  $u = @('B', 'KB', 'MB', 'GB', 'TB')
  $i = 0
  while ($Bytes -ge 1024 -and $i -lt 4) { $Bytes /= 1024; $i++ }
  if ($i -eq 0) { return "$Bytes B" }
  return ('{0:N1} {1}' -f $Bytes, $u[$i])
}

# --- Ventana (Abrir) ---------------------------------------------------------------

function Show-KdPasswordDialog($Vault) {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Kiopia Desk: copias cifradas'
  $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $f.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Font
  $f.ClientSize = New-Object System.Drawing.Size(440, 178)

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Location = New-Object System.Drawing.Point(14, 12)
  $lbl.Size = New-Object System.Drawing.Size(412, 36)
  $lbl.Text = 'Estas copias de Kiopia Desk están cifradas. Escribe la contraseña o la clave de recuperación para verlas.'
  $txt = New-Object System.Windows.Forms.TextBox
  $txt.Location = New-Object System.Drawing.Point(14, 56)
  $txt.Width = 412
  $txt.UseSystemPasswordChar = $true
  $chk = New-Object System.Windows.Forms.CheckBox
  $chk.Location = New-Object System.Drawing.Point(14, 86)
  $chk.AutoSize = $true
  $chk.Text = 'Mostrar lo que escribo'
  $err = New-Object System.Windows.Forms.Label
  $err.Location = New-Object System.Drawing.Point(14, 112)
  $err.Size = New-Object System.Drawing.Size(412, 20)
  $err.ForeColor = [System.Drawing.Color]::Firebrick
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Abrir'
  $ok.Location = New-Object System.Drawing.Point(252, 140)
  $ok.Size = New-Object System.Drawing.Size(84, 28)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancelar'
  $cancel.Location = New-Object System.Drawing.Point(342, 140)
  $cancel.Size = New-Object System.Drawing.Size(84, 28)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $f.Controls.AddRange(@($lbl, $txt, $chk, $err, $ok, $cancel))
  $f.AcceptButton = $ok
  $f.CancelButton = $cancel

  $script:KdUnlocked = $null
  $chk.Add_CheckedChanged({ $txt.UseSystemPasswordChar = -not $chk.Checked })
  $ok.Add_Click({
    $err.Text = ''
    if (-not $txt.Text) { $err.Text = 'Escribe la contraseña o la clave de recuperación.'; return }
    $f.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    $ok.Enabled = $false
    $err.Text = 'Comprobando...'
    $f.Refresh()
    try { $k = Unlock-KdVault $Vault $txt.Text } catch { $k = $null; $script:KdUnlockError = $_.Exception.Message }
    $f.Cursor = [System.Windows.Forms.Cursors]::Default
    $ok.Enabled = $true
    if ($k) {
      $script:KdUnlocked = [byte[]]$k
      $txt.Text = ''
      $f.DialogResult = [System.Windows.Forms.DialogResult]::OK
      $f.Close()
    } else {
      $err.Text = if ($script:KdUnlockError) { $script:KdUnlockError } else { 'La contraseña o la clave de recuperación no es correcta.' }
      $script:KdUnlockError = $null
      $txt.SelectAll()
      $txt.Focus()
    }
  })
  [void]$f.ShowDialog()
  $f.Dispose()
  if ($script:KdUnlocked) { return , $script:KdUnlocked }
  return $null
}

function Show-KdBrowser([string]$BackupRoot, $Catalog) {
  $script:KdTemp = [System.IO.Path]::Combine($env:TEMP, 'KiopiaDesk-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $script:KdBusy = $false
  $script:KdCancel = $false
  $script:KdCloseAfter = $false
  $script:KdIndexes = @{}

  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Kiopia Desk: copias cifradas en ' + $BackupRoot
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $f.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Font
  $f.ClientSize = New-Object System.Drawing.Size(860, 580)
  $f.MinimumSize = New-Object System.Drawing.Size(620, 420)

  $tree = New-Object System.Windows.Forms.TreeView
  $tree.Dock = [System.Windows.Forms.DockStyle]::Fill
  $tree.HideSelection = $false

  $top = New-Object System.Windows.Forms.Label
  $top.Dock = [System.Windows.Forms.DockStyle]::Top
  $top.Height = 44
  $top.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 0)
  $top.Text = 'Elige una carpeta o un archivo. «Ver» abre el archivo con su programa (con una copia temporal que se borra al cerrar esta ventana). «Sacar…» guarda lo elegido, ya descifrado, donde tú digas.'

  $bottom = New-Object System.Windows.Forms.Panel
  $bottom.Dock = [System.Windows.Forms.DockStyle]::Bottom
  # Con su ancho real ANTES de colocar los botones: anclados a la derecha, se
  # quedaban a la distancia del ancho por defecto (200) y fuera de la ventana.
  $bottom.Size = New-Object System.Drawing.Size($f.ClientSize.Width, 78)
  $status = New-Object System.Windows.Forms.Label
  $status.Location = New-Object System.Drawing.Point(10, 8)
  $status.Size = New-Object System.Drawing.Size(840, 20)
  $status.Anchor = 'Top, Left, Right'
  $status.AutoEllipsis = $true
  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Location = New-Object System.Drawing.Point(10, 38)
  $bar.Size = New-Object System.Drawing.Size(530, 26)
  $bar.Anchor = 'Top, Left, Right'
  $bar.Maximum = 1000
  $bar.Visible = $false
  $btnVer = New-Object System.Windows.Forms.Button
  $btnVer.Text = 'Ver'
  $btnVer.Size = New-Object System.Drawing.Size(92, 30)
  $btnVer.Location = New-Object System.Drawing.Point(556, 36)
  $btnVer.Anchor = 'Top, Right'
  $btnSacar = New-Object System.Windows.Forms.Button
  $btnSacar.Text = 'Sacar…'
  $btnSacar.Size = New-Object System.Drawing.Size(92, 30)
  $btnSacar.Location = New-Object System.Drawing.Point(654, 36)
  $btnSacar.Anchor = 'Top, Right'
  $btnCerrar = New-Object System.Windows.Forms.Button
  $btnCerrar.Text = 'Cerrar'
  $btnCerrar.Size = New-Object System.Drawing.Size(92, 30)
  $btnCerrar.Location = New-Object System.Drawing.Point(752, 36)
  $btnCerrar.Anchor = 'Top, Right'
  $bottom.Controls.AddRange(@($status, $bar, $btnVer, $btnSacar, $btnCerrar))

  # El que ocupa el resto va primero: los anclados arriba y abajo se colocan antes.
  $f.Controls.Add($tree)
  $f.Controls.Add($top)
  $f.Controls.Add($bottom)

  # Índice de carpetas de cada carpeta respaldada ("" = su raíz), al abrirla
  # por primera vez: prefijo -> @{ Dirs; Files }.
  function Get-KdFolderIndex($Source) {
    if ($script:KdIndexes.ContainsKey($Source.Carpeta)) { return $script:KdIndexes[$Source.Carpeta] }
    $idx = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($k in $Source.Archivos.Keys) {
      $parts = $k.Split('/')
      $prefix = ''
      for ($i = 0; $i -lt $parts.Length; $i++) {
        if (-not $idx.ContainsKey($prefix)) {
          $idx[$prefix] = @{ Dirs = (New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::CurrentCultureIgnoreCase)); Files = (New-Object System.Collections.Generic.List[string]) }
        }
        if ($i -eq $parts.Length - 1) {
          $idx[$prefix].Files.Add($k)
        } else {
          [void]$idx[$prefix].Dirs.Add($parts[$i])
          $prefix = if ($prefix) { $prefix + '/' + $parts[$i] } else { $parts[$i] }
        }
      }
    }
    $script:KdIndexes[$Source.Carpeta] = $idx
    return $idx
  }

  function New-KdDirNode([string]$Text, $Tag) {
    $n = New-Object System.Windows.Forms.TreeNode($Text)
    $n.Tag = $Tag
    $dummy = $n.Nodes.Add('…')
    $dummy.Tag = 'kd-pendiente'
    return $n
  }

  function Add-KdChildren($Node) {
    $t = $Node.Tag
    $f.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    try {
      $idx = Get-KdFolderIndex $t.Source
      $entry = $null
      [void]$idx.TryGetValue($t.Prefix, [ref]$entry)
      $nodes = New-Object System.Collections.Generic.List[System.Windows.Forms.TreeNode]
      if ($entry) {
        foreach ($d in $entry.Dirs) {
          $p = if ($t.Prefix) { $t.Prefix + '/' + $d } else { $d }
          $nodes.Add((New-KdDirNode $d @{ Kind = 'dir'; Source = $t.Source; Prefix = $p; Name = $d }))
        }
        $files = @($entry.Files | Sort-Object { $_.Substring($_.LastIndexOf('/') + 1) })
        foreach ($k in $files) {
          $name = $k.Substring($k.LastIndexOf('/') + 1)
          $size = (Get-KdField $t.Source.Archivos[$k] 'size')
          $n = New-Object System.Windows.Forms.TreeNode("$name   ($(Format-KdSize ([double]$size)))")
          $n.Tag = @{ Kind = 'file'; Source = $t.Source; Rel = $k; Name = $name }
          $nodes.Add($n)
        }
      }
      $tree.BeginUpdate()
      $Node.Nodes.Clear()
      $Node.Nodes.AddRange($nodes.ToArray())
      $tree.EndUpdate()
    } finally { $f.Cursor = [System.Windows.Forms.Cursors]::Default }
  }

  function Get-KdSelectedItems($Node, [string]$DestBase) {
    $t = $Node.Tag
    $list = New-Object System.Collections.ArrayList
    switch ($t.Kind) {
      'file' {
        [void]$list.Add(@{ Carpeta = $t.Source.Carpeta; Rel = $t.Rel; Entry = $t.Source.Archivos[$t.Rel]; Target = [System.IO.Path]::Combine($DestBase, $t.Name) })
      }
      'dir' {
        $list.AddRange((Get-KdItems $t.Source $t.Prefix ([System.IO.Path]::Combine($DestBase, $t.Name))))
      }
      'root' {
        foreach ($s in $Catalog.Fuentes) { $list.AddRange((Get-KdItems $s '' ([System.IO.Path]::Combine($DestBase, $s.Carpeta)))) }
      }
    }
    return , $list
  }

  function Update-KdButtons {
    $n = $tree.SelectedNode
    $btnVer.Enabled = -not $script:KdBusy -and $n -and $n.Tag -is [hashtable] -and $n.Tag.Kind -eq 'file'
    $btnSacar.Enabled = $script:KdBusy -or ($n -and $n.Tag -is [hashtable])
    $btnSacar.Text = if ($script:KdBusy) { 'Detener' } else { 'Sacar…' }
    $btnCerrar.Enabled = -not $script:KdBusy
  }

  # Deja que la ventana responda durante un descifrado largo, y lo corta si se pidió.
  $script:KdPump = {
    param($n, $phase)
    if ($phase -eq 'd') {
      $script:KdDone += $n
      if ($script:KdTotal -gt 0) { $bar.Value = [int][Math]::Min(1000, 1000 * $script:KdDone / $script:KdTotal) }
    }
    [System.Windows.Forms.Application]::DoEvents()
    if ($script:KdCancel) { throw 'KD-CANCEL' }
  }

  function Invoke-KdView {
    $n = $tree.SelectedNode
    if (-not $n -or $n.Tag -isnot [hashtable] -or $n.Tag.Kind -ne 'file' -or $script:KdBusy) { return }
    $t = $n.Tag
    $blob = Get-KdDataPath $script:KdMk $BackupRoot $t.Source.Carpeta $t.Rel
    if (-not [System.IO.File]::Exists($blob)) {
      [void][System.Windows.Forms.MessageBox]::Show('Este archivo no está en el disco de backup (se borró o el disco está dañado).', 'Kiopia Desk', 'OK', 'Warning')
      return
    }
    $dir = [System.IO.Path]::Combine($script:KdTemp, [guid]::NewGuid().ToString('N').Substring(0, 6))
    $script:KdBusy = $true; $script:KdCancel = $false; $script:KdDone = 0
    $script:KdTotal = [double](Get-KdField $t.Source.Archivos[$t.Rel] 'size')
    $bar.Value = 0; $bar.Visible = $true
    Update-KdButtons
    $status.Text = 'Descifrando ' + $t.Name + '...'
    try {
      $path = Restore-KdEntry $script:KdMk $blob ([System.IO.Path]::Combine($dir, $t.Name)) $t.Source.Archivos[$t.Rel] $script:KdPump
      $status.Text = 'Abierto: ' + $t.Name + ' (copia temporal: se borra al cerrar esta ventana).'
      try { Start-Process -FilePath $path } catch {
        [void][System.Windows.Forms.MessageBox]::Show("No hay un programa para abrir este tipo de archivo.`n`nUsa «Sacar…» para guardarlo.", 'Kiopia Desk', 'OK', 'Information')
      }
    } catch {
      $status.Text = if ($_.Exception.Message -eq 'KD-CANCEL') { 'Cancelado.' } else { 'No se pudo abrir: ' + $_.Exception.Message }
    } finally {
      $script:KdBusy = $false; $bar.Visible = $false
      Update-KdButtons
      if ($script:KdCloseAfter) { $f.Close() }
    }
  }

  function Invoke-KdExport {
    $n = $tree.SelectedNode
    if (-not $n -or $n.Tag -isnot [hashtable]) { return }
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Elige dónde guardar lo elegido (ya descifrado). Se creará una carpeta con su nombre; no se reemplaza nada que ya exista.'
    $dlg.ShowNewFolderButton = $true
    if ($dlg.ShowDialog($f) -ne [System.Windows.Forms.DialogResult]::OK) { return }
    $destBase = $dlg.SelectedPath
    if ($destBase.StartsWith($BackupRoot, [StringComparison]::OrdinalIgnoreCase)) {
      [void][System.Windows.Forms.MessageBox]::Show('Elige una carpeta fuera del backup: si se guarda dentro, quedaría sin cifrar junto a las copias.', 'Kiopia Desk', 'OK', 'Warning')
      return
    }
    $items = Get-KdSelectedItems $n $destBase
    # Lo que se crea: una carpeta con el nombre de lo elegido (o el archivo suelto).
    $shownDir = if ($n.Tag.Kind -eq 'dir') { [System.IO.Path]::Combine($destBase, $n.Tag.Name) } else { $destBase }
    if (-not $items.Count) { $status.Text = 'No hay archivos en lo elegido.'; return }
    $script:KdBusy = $true; $script:KdCancel = $false; $script:KdDone = 0
    $script:KdTotal = 0
    foreach ($it in $items) { $script:KdTotal += [double](Get-KdField $it.Entry 'size') }
    $bar.Value = 0; $bar.Visible = $true
    Update-KdButtons
    $script:KdCount = 0
    $total = $items.Count
    $onFile = {
      param($it)
      $script:KdCount++
      $status.Text = "Guardando $($script:KdCount) de ${total}: $($it.Rel)"
      [System.Windows.Forms.Application]::DoEvents()
      if ($script:KdCancel) { throw 'KD-CANCEL' }
    }
    try {
      $r = Export-KdItems $script:KdMk $BackupRoot $items $onFile $script:KdPump
      $msg = "Se guardaron $($r.Ok) de $total archivo(s) en:`n$shownDir"
      if ($r.Fallidos.Count) {
        $msg += "`n`nNo se pudieron sacar $($r.Fallidos.Count):`n" + (($r.Fallidos | Select-Object -First 10) -join "`n")
        if ($r.Fallidos.Count -gt 10) { $msg += "`n..." }
      }
      $status.Text = "Guardados $($r.Ok) de $total archivo(s)."
      if (-not $script:KdCloseAfter) {
        $ans = [System.Windows.Forms.MessageBox]::Show($msg + "`n`n¿Abrir la carpeta?", 'Kiopia Desk', 'YesNo', $(if ($r.Fallidos.Count) { 'Warning' } else { 'Information' }))
        if ($ans -eq [System.Windows.Forms.DialogResult]::Yes) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $shownDir + '"') }
      }
    } catch {
      $status.Text = if ($_.Exception.Message -eq 'KD-CANCEL') { "Detenido: se guardaron $([Math]::Max(0, $script:KdCount - 1)) archivo(s) completos; el que se estaba guardando no quedó a medias." } else { 'Error: ' + $_.Exception.Message }
    } finally {
      $script:KdBusy = $false; $bar.Visible = $false
      Update-KdButtons
      if ($script:KdCloseAfter) { $f.Close() }
    }
  }

  # Árbol: todas las carpetas respaldadas bajo una raíz.
  $count = 0
  $bytes = 0
  foreach ($s in $Catalog.Fuentes) {
    foreach ($v in $s.Archivos.Values) { $count++; $bytes += [double](Get-KdField $v 'size') }
  }
  $root = New-Object System.Windows.Forms.TreeNode("Copias en $BackupRoot")
  $root.Tag = @{ Kind = 'root'; Name = 'Kiopia Desk' }
  foreach ($s in $Catalog.Fuentes) {
    [void]$root.Nodes.Add((New-KdDirNode $s.Fuente @{ Kind = 'dir'; Source = $s; Prefix = ''; Name = $s.Carpeta }))
  }
  [void]$tree.Nodes.Add($root)
  $root.Expand()
  $tree.SelectedNode = $root
  $status.Text = "$($Catalog.Fuentes.Count) carpeta(s), $count archivo(s), $(Format-KdSize $bytes)."
  Update-KdButtons

  $tree.Add_BeforeExpand({
    param($sender, $e)
    $n = $e.Node
    if ($n.Nodes.Count -eq 1 -and $n.Nodes[0].Tag -eq 'kd-pendiente') { Add-KdChildren $n }
  })
  $tree.Add_AfterSelect({ Update-KdButtons })
  $tree.Add_NodeMouseDoubleClick({
    param($sender, $e)
    if ($e.Node.Tag -is [hashtable] -and $e.Node.Tag.Kind -eq 'file') { $tree.SelectedNode = $e.Node; Invoke-KdView }
  })
  $btnVer.Add_Click({ Invoke-KdView })
  $btnSacar.Add_Click({ if ($script:KdBusy) { $script:KdCancel = $true } else { Invoke-KdExport } })
  $btnCerrar.Add_Click({ $f.Close() })
  $f.Add_FormClosing({
    param($sender, $e)
    if ($script:KdBusy) {
      $e.Cancel = $true
      $script:KdCancel = $true
      $script:KdCloseAfter = $true
    }
  })
  $f.Add_Shown({
    if ($Catalog.Avisos.Count) {
      [void][System.Windows.Forms.MessageBox]::Show(($Catalog.Avisos -join "`n"), 'Kiopia Desk', 'OK', 'Warning')
    }
    if (-not $Catalog.Fuentes.Count) { $status.Text = 'Este backup cifrado todavía no tiene copias.' }
  })

  [void]$f.ShowDialog()
  $f.Dispose()
}

# Borra las copias temporales de «Ver». Si un programa aún tiene alguna
# abierta, se pide cerrarlo y se reintenta.
function Remove-KdTemp {
  if (-not $script:KdTemp -or -not [System.IO.Directory]::Exists($script:KdTemp)) { return }
  for ($i = 0; $i -lt 5; $i++) {
    try { [System.IO.Directory]::Delete($script:KdTemp, $true); return } catch { }
    $ans = [System.Windows.Forms.MessageBox]::Show(
      "Algún archivo que abriste con «Ver» sigue abierto en otro programa, así que su copia descifrada no se puede borrar todavía.`n`nCiérralo y pulsa «Reintentar».",
      'Kiopia Desk', 'RetryCancel', 'Warning')
    if ($ans -ne [System.Windows.Forms.DialogResult]::Retry) { break }
  }
  [void][System.Windows.Forms.MessageBox]::Show("No se pudieron borrar las copias temporales. Bórralas a mano cuando cierres ese programa:`n`n$($script:KdTemp)", 'Kiopia Desk', 'OK', 'Warning')
}

function Show-KdOpen([string]$BackupRoot) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $vault = Read-KdVault $BackupRoot
  $mk = Show-KdPasswordDialog $vault
  if (-not $mk) { return }
  $script:KdMk = [byte[]]$mk
  try {
    $catalog = Get-KdCatalog $script:KdMk $BackupRoot
    Show-KdBrowser $BackupRoot $catalog
  } finally {
    Remove-KdTemp
    [Array]::Clear($script:KdMk, 0, $script:KdMk.Length)
    $script:KdMk = $null
    Clear-KdNameCache
  }
}

if ($Accion -eq 'Import') { return }

$root = Resolve-KdBackupRoot $Backup

if ($Accion -eq 'Recuperar') {
  if (-not $Secreto) {
    $ss = Read-Host 'Contraseña o clave de recuperación' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    try { $Secreto = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if (-not $Destino) { $Destino = Read-Host 'Carpeta donde dejar los archivos' }
  $Destino = [System.IO.Path]::GetFullPath($Destino)
  $r = Invoke-KdRecover $root $Secreto $Destino $Carpeta
  foreach ($a in $r.Avisos) { Write-Output "Aviso: $a" }
  foreach ($x in $r.Fallidos) { Write-Output "No se pudo: $x" }
  Write-Output "Recuperados $($r.Ok) de $($r.Total) archivo(s) en $Destino"
  Write-Output ('KD-RESUMEN ' + (@{ recuperados = $r.Ok; total = $r.Total; fallidos = $r.Fallidos.Count; faltan = $r.Faltan } | ConvertTo-Json -Compress))
  exit $(if ($r.Fallidos.Count) { 1 } else { 0 })
}

try {
  Show-KdOpen $root
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show("No se pudo abrir el backup cifrado:`n`n$($_.Exception.Message)", 'Kiopia Desk', 'OK', 'Error')
}

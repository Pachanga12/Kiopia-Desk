# Kopia Desk v2 - ayudante de BitLocker.
#
# La app lo lanza ELEVADO (Start-Process -Verb RunAs) sólo para la operación
# pedida; la app en sí nunca corre como administrador. Nada secreto viaja por
# la línea de comandos ni pasa por Electron:
#   - la contraseña se pide en una ventana propia de este proceso;
#   - la clave de recuperación se genera aquí, se muestra aquí y sólo se
#     escribe donde el usuario elija guardarla (nunca en el disco a cifrar).
# El progreso se comunica escribiendo JSON (sin secretos) en -StatusFile, que
# la app lee cada poco.
#
# -Action Import sólo carga las funciones (para pruebas: ". .\bitlocker-helper.ps1 -Action Import").

param(
  [ValidateSet('Encrypt', 'Lock', 'Import')] [string]$Action = 'Import',
  [ValidatePattern('^[A-Za-z]$')] [string]$Drive,
  [string]$StatusFile,
  [switch]$FullDisk,
  # Identidad del volumen que el usuario eligió (Get-Volume UniqueId). Antes de
  # actuar se comprueba que la letra sigue apuntando a este mismo volumen.
  [ValidatePattern('^\\\\\?\\Volume\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\\$')] [string]$VolumeId
)

$ErrorActionPreference = 'Stop'

function Write-KdStatus([hashtable]$Data) {
  if (-not $StatusFile) { return }
  $Data['action'] = $Action
  $Data['drive'] = $Drive
  $Data['ts'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $json = $Data | ConvertTo-Json -Compress
  # Escritura atómica: la app nunca lee un JSON a medias.
  $tmp = $StatusFile + '.kopia-tmp'
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $StatusFile -Force
}

function New-KdError([string]$Code, [string]$Message) {
  $e = New-Object System.Exception $Message
  $e.Data['kdCode'] = $Code
  return $e
}

# Clave de recuperación de 48 dígitos en el formato de BitLocker: 8 grupos de
# 6 dígitos, cada uno múltiplo de 11 y menor que 720896 (16 bits por grupo,
# 128 bits en total). Se genera con un RNG criptográfico ANTES de cifrar, para
# poder obligar a guardarla antes de empezar.
function New-KdRecoveryPassword {
  $bytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $groups = for ($i = 0; $i -lt 8; $i++) {
    ([int][BitConverter]::ToUInt16($bytes, $i * 2) * 11).ToString('000000')
  }
  return ($groups -join '-')
}

function Test-KdRecoveryPassword([string]$Key) {
  $parts = $Key -split '-'
  if ($parts.Count -ne 8) { return $false }
  foreach ($p in $parts) {
    if ($p -notmatch '^\d{6}$') { return $false }
    $n = [int]$p
    if (($n % 11) -ne 0 -or $n -ge 720896) { return $false }
  }
  return $true
}

# 0-5: largo >= 12, largo >= 16, mayúsculas y minúsculas, dígitos, símbolos.
function Get-KdPasswordScore([string]$Password) {
  $score = 0
  if ($Password.Length -ge 12) { $score++ }
  if ($Password.Length -ge 16) { $score++ }
  if ($Password -cmatch '[a-z]' -and $Password -cmatch '[A-Z]') { $score++ }
  if ($Password -match '\d') { $score++ }
  if ($Password -match '[^A-Za-z0-9]') { $score++ }
  return $score
}

function Get-KdMountPoint { return ($Drive.ToUpper() + ':') }

# Decisión pura (sin consultar Windows, para poder probarla con datos simulados):
# ¿se puede cifrar/bloquear la letra? Sólo si sigue siendo el volumen esperado,
# no es la unidad de Windows y está en un disco físico conocido que no es el
# del sistema. Ante cualquier dato desconocido, no.
function Test-KdTargetAllowed {
  param(
    [string]$Letter,
    [string]$SystemLetter,
    $DiskNumber,
    [int[]]$SystemDisks,
    [string]$CurrentVolumeId,
    [string]$ExpectedVolumeId
  )
  $L = $Letter.ToUpper()
  if (-not $CurrentVolumeId) {
    return @{ ok = $false; code = 'missing'; message = "El disco ${L}: ya no está conectado." }
  }
  if (-not $ExpectedVolumeId -or $CurrentVolumeId -ne $ExpectedVolumeId) {
    return @{ ok = $false; code = 'changed'; message = "El disco ${L}: cambió desde que lo elegiste (se desconectó o se conectó otro con la misma letra). No se hizo nada." }
  }
  if (-not $SystemLetter -or $L -eq $SystemLetter.TrimEnd(':').ToUpper()) {
    return @{ ok = $false; code = 'system-disk'; message = "${L}: es la unidad de Windows. Kopia Desk no la cifra ni la bloquea." }
  }
  if ($null -eq $DiskNumber) {
    return @{ ok = $false; code = 'system-check-failed'; message = "No se pudo confirmar en qué disco está ${L}:; por seguridad no se continúa." }
  }
  if (@($SystemDisks) -contains [int]$DiskNumber) {
    return @{ ok = $false; code = 'system-disk'; message = "${L}: está en el disco del sistema (donde está instalado Windows). Kopia Desk no cifra ni bloquea ese disco." }
  }
  return @{ ok = $true }
}

# Datos reales de Windows para Test-KdTargetAllowed. Lo que no se pueda leer
# queda en $null, y eso bloquea la operación.
function Get-KdTargetFacts {
  $facts = @{ SystemLetter = $null; SystemDisks = @(); DiskNumber = $null; CurrentVolumeId = $null }
  try { $facts.SystemLetter = ([string](Get-CimInstance Win32_OperatingSystem).SystemDrive).TrimEnd(':') } catch { }
  try {
    $facts.SystemDisks = @(Get-Disk | Where-Object { $_.IsBoot -or $_.IsSystem } | ForEach-Object { [int]$_.Number })
    if ($facts.SystemLetter) {
      $facts.SystemDisks += [int](Get-Partition -DriveLetter $facts.SystemLetter).DiskNumber
    }
  } catch { }
  try { $facts.DiskNumber = [int](Get-Partition -DriveLetter $Drive -ErrorAction Stop).DiskNumber } catch { }
  try { $facts.CurrentVolumeId = [string](Get-Volume -DriveLetter $Drive -ErrorAction Stop).UniqueId } catch { }
  return $facts
}

# Se llama al empezar y otra vez justo antes de cifrar o bloquear: entre una y
# otra pueden pasar minutos (el usuario escribiendo la contraseña) y el disco
# puede haberse cambiado.
function Assert-KdTarget {
  $f = Get-KdTargetFacts
  $r = Test-KdTargetAllowed -Letter $Drive -SystemLetter $f.SystemLetter -DiskNumber $f.DiskNumber `
    -SystemDisks $f.SystemDisks -CurrentVolumeId $f.CurrentVolumeId -ExpectedVolumeId $VolumeId
  if (-not $r.ok) { throw (New-KdError $r.code $r.message) }
}

# --- Ventanas --------------------------------------------------------------

function New-KdForm([string]$Title, [int]$Width, [int]$Height) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.ClientSize = New-Object System.Drawing.Size($Width, $Height)
  $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $form.Add_Shown({ $this.Activate() })
  return $form
}

function New-KdLabel([string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $Text
  $l.Location = New-Object System.Drawing.Point($X, $Y)
  $l.Size = New-Object System.Drawing.Size($W, $H)
  return $l
}

function New-KdButton([string]$Text, [int]$X, [int]$Y, [int]$W) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $Text
  $b.Location = New-Object System.Drawing.Point($X, $Y)
  $b.Size = New-Object System.Drawing.Size($W, 32)
  return $b
}

# Devuelve la contraseña elegida, o $null si se cancela.
function Show-KdPasswordDialog([string]$DriveLabel) {
  $mp = Get-KdMountPoint
  $form = New-KdForm "Kopia Desk v2 - Contraseña para $mp" 470 330

  $form.Controls.Add((New-KdLabel ("Elige la contraseña del disco $mp $DriveLabel. Te la pedirá cada vez que lo conectes, " +
        'en este o en otro equipo con Windows.') 16 14 438 44))
  $form.Controls.Add((New-KdLabel 'Contraseña (mínimo 12 caracteres)' 16 66 438 22))
  $pw1 = New-Object System.Windows.Forms.TextBox
  $pw1.UseSystemPasswordChar = $true
  $pw1.Location = New-Object System.Drawing.Point(16, 88)
  $pw1.Size = New-Object System.Drawing.Size(438, 26)
  $form.Controls.Add($pw1)
  $form.Controls.Add((New-KdLabel 'Repite la contraseña' 16 124 438 22))
  $pw2 = New-Object System.Windows.Forms.TextBox
  $pw2.UseSystemPasswordChar = $true
  $pw2.Location = New-Object System.Drawing.Point(16, 146)
  $pw2.Size = New-Object System.Drawing.Size(438, 26)
  $form.Controls.Add($pw2)

  $strength = New-KdLabel '' 16 182 438 22
  $strength.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($strength)
  $hint = New-KdLabel ('Si la olvidas, sólo podrás abrir el disco con la clave de recuperación que verás en el ' +
    'siguiente paso.') 16 208 438 44
  $hint.ForeColor = [System.Drawing.Color]::DimGray
  $form.Controls.Add($hint)

  $cancel = New-KdButton 'Cancelar' 254 272 96
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $ok = New-KdButton 'Continuar' 358 272 96
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Enabled = $false
  $form.Controls.Add($cancel)
  $form.Controls.Add($ok)
  $form.AcceptButton = $ok
  $form.CancelButton = $cancel

  $update = {
    $p = $pw1.Text
    $score = Get-KdPasswordScore $p
    if ($p.Length -eq 0) {
      $strength.Text = ''
    } elseif ($p.Length -lt 12) {
      $strength.Text = "Muy corta: faltan $(12 - $p.Length) caracteres"
      $strength.ForeColor = [System.Drawing.Color]::Firebrick
    } elseif ($score -le 2) {
      $strength.Text = 'Fortaleza: aceptable (agrega mayúsculas, números o símbolos)'
      $strength.ForeColor = [System.Drawing.Color]::DarkOrange
    } else {
      $strength.Text = 'Fortaleza: buena'
      $strength.ForeColor = [System.Drawing.Color]::ForestGreen
    }
    $match = $p -ceq $pw2.Text
    if ($pw2.Text.Length -gt 0 -and -not $match) {
      $strength.Text = 'Las contraseñas no coinciden'
      $strength.ForeColor = [System.Drawing.Color]::Firebrick
    }
    $ok.Enabled = ($p.Length -ge 12) -and $match
  }
  $pw1.Add_TextChanged($update)
  $pw2.Add_TextChanged($update)

  $result = $form.ShowDialog()
  $password = $pw1.Text
  $pw1.Text = ''
  $pw2.Text = ''
  $form.Dispose()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $password
}

# Muestra la clave de recuperación y obliga a guardarla (archivo en otro disco
# o copiarla) antes de dejar continuar. Devuelve $true si se confirma.
function Show-KdRecoveryDialog([string]$Key, [string]$DriveLabel) {
  $mp = Get-KdMountPoint
  $form = New-KdForm "Kopia Desk v2 - Clave de recuperación de $mp" 540 360

  $title = New-KdLabel 'Guarda tu clave de recuperación' 16 12 508 26
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($title)
  $form.Controls.Add((New-KdLabel ('Si olvidas la contraseña, esta clave es la ÚNICA forma de abrir el disco. Guárdala ' +
        'FUERA de este disco: en otro disco, en tu cuenta Microsoft o impresa. Sin contraseña ni clave, los datos no ' +
        'se pueden recuperar.') 16 42 508 64))

  $box = New-Object System.Windows.Forms.TextBox
  $box.ReadOnly = $true
  $box.Text = $Key
  $box.TextAlign = 'Center'
  $box.Font = New-Object System.Drawing.Font('Consolas', 13)
  $box.Location = New-Object System.Drawing.Point(16, 112)
  $box.Size = New-Object System.Drawing.Size(508, 30)
  $form.Controls.Add($box)

  $save = New-KdButton 'Guardar en archivo...' 16 154 180
  $copy = New-KdButton 'Copiar' 204 154 100
  $form.Controls.Add($save)
  $form.Controls.Add($copy)
  $saved = New-KdLabel '' 16 192 508 40
  $saved.ForeColor = [System.Drawing.Color]::ForestGreen
  $form.Controls.Add($saved)

  $check = New-Object System.Windows.Forms.CheckBox
  $check.Text = 'Guardé la clave en un lugar seguro, fuera de este disco'
  $check.Location = New-Object System.Drawing.Point(16, 238)
  $check.Size = New-Object System.Drawing.Size(508, 26)
  $check.Enabled = $false
  $form.Controls.Add($check)

  $cancel = New-KdButton 'Cancelar' 318 304 96
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $ok = New-KdButton 'Cifrar ahora' 422 304 102
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Enabled = $false
  $form.Controls.Add($cancel)
  $form.Controls.Add($ok)
  $form.CancelButton = $cancel

  $check.Add_CheckedChanged({ $ok.Enabled = $check.Checked })

  $save.Add_Click({
      $dlg = New-Object System.Windows.Forms.SaveFileDialog
      $dlg.Title = 'Guardar clave de recuperación (en OTRO disco)'
      $dlg.Filter = 'Texto (*.txt)|*.txt'
      $dlg.FileName = "Clave de recuperacion BitLocker - disco $($Drive.ToUpper()).txt"
      $dlg.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
      if ($dlg.ShowDialog($form) -ne [System.Windows.Forms.DialogResult]::OK) { return }
      $root = [System.IO.Path]::GetPathRoot($dlg.FileName)
      if ($root -ieq "$mp\") {
        [System.Windows.Forms.MessageBox]::Show($form,
          "No guardes la clave en el disco que vas a cifrar: si no lo puedes abrir, tampoco podrías leer la clave. Elige otro disco.",
          'Kopia Desk v2', 'OK', 'Warning') | Out-Null
        return
      }
      $content = @(
        'Clave de recuperación de BitLocker (creada con Kopia Desk v2)'
        "Disco: $mp $DriveLabel"
        "Fecha: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
        ''
        "Clave: $Key"
        ''
        'Para abrir el disco sin la contraseña: al pedirte la contraseña, elige'
        '"Más opciones" > "Escribir clave de recuperación" y escribe la clave.'
      ) -join "`r`n"
      [System.IO.File]::WriteAllText($dlg.FileName, $content, (New-Object System.Text.UTF8Encoding $true))
      $saved.Text = "Guardada en: $($dlg.FileName)"
      $check.Enabled = $true
    })

  $copy.Add_Click({
      [System.Windows.Forms.Clipboard]::SetText($Key)
      $saved.Text = 'Copiada al portapapeles. Pégala en un lugar seguro (p. ej. un gestor de contraseñas) y luego bórrala del portapapeles.'
      $check.Enabled = $true
    })

  $result = $form.ShowDialog()
  $box.Text = ''
  $form.Dispose()
  return ($result -eq [System.Windows.Forms.DialogResult]::OK)
}

# --- Operaciones ------------------------------------------------------------

# Activa BitLocker con la clave de recuperación ya guardada por el usuario y
# agrega la contraseña. Primero la clave de recuperación: si agregar la
# contraseña fallara, el disco sigue siendo abrible con la clave que el usuario
# ya guardó. Al final confirma el estado real con Get-BitLockerVolume.
function Enable-KdBitLocker([string]$MountPoint, [securestring]$SecurePassword, [string]$RecoveryPassword, [switch]$FullDisk) {
  if (-not (Test-KdRecoveryPassword $RecoveryPassword)) {
    throw (New-KdError 'internal' 'La clave de recuperación generada no tiene un formato válido.')
  }
  $params = @{
    MountPoint                = $MountPoint
    # AES (no XTS): legible también en Windows 8.1 / Server 2012 R2, según Microsoft.
    EncryptionMethod          = 'Aes256'
    RecoveryPasswordProtector = $true
    RecoveryPassword          = $RecoveryPassword
  }
  if (-not $FullDisk) { $params['UsedSpaceOnly'] = $true }
  Enable-BitLocker @params -WarningAction SilentlyContinue | Out-Null

  try {
    Add-BitLockerKeyProtector -MountPoint $MountPoint -PasswordProtector -Password $SecurePassword -WarningAction SilentlyContinue | Out-Null
  } catch {
    throw (New-KdError 'password-protector-failed' ("El disco se está cifrando, pero no se pudo agregar la contraseña: " +
        "ábrelo con la clave de recuperación y agrega una contraseña desde el panel de BitLocker. Detalle: " + $_.Exception.Message))
  }

  $v = Get-BitLockerVolume -MountPoint $MountPoint
  $types = @($v.KeyProtector | ForEach-Object { [string]$_.KeyProtectorType })
  $recovery = @($v.KeyProtector | Where-Object { [string]$_.KeyProtectorType -eq 'RecoveryPassword' -and $_.RecoveryPassword -eq $RecoveryPassword })
  if (-not ($types -contains 'Password') -or $recovery.Count -eq 0) {
    throw (New-KdError 'verify-failed' 'Windows no confirmó los protectores de BitLocker (contraseña y clave de recuperación).')
  }
}

# Informa el porcentaje hasta terminar. El cifrado lo hace Windows: si este
# proceso se cierra o el disco se desconecta, BitLocker continúa al reconectarlo.
function Watch-KdEncryption([string]$MountPoint, [int]$IntervalMs = 2000) {
  while ($true) {
    try {
      $v = Get-BitLockerVolume -MountPoint $MountPoint
    } catch {
      Write-KdStatus @{ phase = 'disconnected' }
      return
    }
    $pct = [double]$v.EncryptionPercentage
    if ([string]$v.VolumeStatus -eq 'FullyEncrypted' -or $pct -ge 100) {
      Write-KdStatus @{ phase = 'done'; percent = 100 }
      return
    }
    Write-KdStatus @{ phase = 'encrypting'; percent = [math]::Round($pct, 1) }
    Start-Sleep -Milliseconds $IntervalMs
  }
}

function Invoke-KdEncrypt {
  Assert-KdTarget
  $mp = Get-KdMountPoint
  if (-not (Get-Command Enable-BitLocker -ErrorAction SilentlyContinue)) {
    throw (New-KdError 'edition' 'Esta edición de Windows no puede cifrar discos con BitLocker (Windows Home). Sí puede abrir discos ya cifrados.')
  }
  $vol = Get-BitLockerVolume -MountPoint $mp
  if ([string]$vol.VolumeStatus -ne 'FullyDecrypted' -or @($vol.KeyProtector).Count -gt 0) {
    throw (New-KdError 'already' 'Este disco ya tiene BitLocker configurado.')
  }
  $label = ''
  try { $label = [string](Get-Volume -DriveLetter $Drive).FileSystemLabel } catch { }
  if ($label) { $label = "($label)" }

  Write-KdStatus @{ phase = 'waiting-password' }
  $password = Show-KdPasswordDialog $label
  if ($null -eq $password) { Write-KdStatus @{ phase = 'cancelled' }; return }

  $key = New-KdRecoveryPassword
  Write-KdStatus @{ phase = 'waiting-recovery' }
  if (-not (Show-KdRecoveryDialog $key $label)) {
    $password = $null
    Write-KdStatus @{ phase = 'cancelled' }
    return
  }

  # Segunda comprobación, justo antes de tocar el disco: pudo cambiarse
  # mientras el usuario escribía la contraseña o guardaba la clave.
  try {
    Assert-KdTarget
    $vol = Get-BitLockerVolume -MountPoint $mp
    if ([string]$vol.VolumeStatus -ne 'FullyDecrypted' -or @($vol.KeyProtector).Count -gt 0) {
      throw (New-KdError 'already' 'El disco ya tiene BitLocker configurado. No se hizo nada.')
    }
  } catch {
    $password = $null
    $key = $null
    throw
  }

  Write-KdStatus @{ phase = 'enabling' }
  $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
  $password = $null
  Enable-KdBitLocker -MountPoint $mp -SecurePassword $secure -RecoveryPassword $key -FullDisk:$FullDisk
  $key = $null
  $secure.Dispose()
  Watch-KdEncryption $mp
}

function Invoke-KdLock {
  Assert-KdTarget
  $mp = Get-KdMountPoint
  Write-KdStatus @{ phase = 'locking' }
  Lock-BitLocker -MountPoint $mp -ForceDismount -WarningAction SilentlyContinue | Out-Null
  $v = Get-BitLockerVolume -MountPoint $mp
  if ([string]$v.LockStatus -ne 'Locked') {
    throw (New-KdError 'verify-failed' 'Windows no confirmó el bloqueo del disco.')
  }
  Write-KdStatus @{ phase = 'done' }
}

# --- Entrada ------------------------------------------------------------------

if ($Action -eq 'Import') { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

try {
  switch ($Action) {
    'Encrypt' { Invoke-KdEncrypt }
    'Lock' { Invoke-KdLock }
  }
} catch {
  $code = 'error'
  $message = $_.Exception.Message
  if ($_.Exception.Data.Contains('kdCode')) {
    $code = [string]$_.Exception.Data['kdCode']
  } elseif ($message -match 'protegid[oa] contra escritura|write.protect') {
    $code = 'write-protected'
  }
  Write-KdStatus @{ phase = 'error'; code = $code; error = $message }
  exit 1
}

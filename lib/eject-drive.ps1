# Kopia Desk v2 - expulsar un disco ("Quitar hardware de forma segura").
#
# Lo lanza la app SIN elevar. Busca el dispositivo del disco de la letra dada y
# pide a Windows que lo expulse (CM_Request_Device_Eject). Sólo expulsa un
# dispositivo que Windows marca como EXTRAÍBLE (el propio disco o el primero así
# hacia arriba, p. ej. el USB): nunca pide expulsar una controladora interna.
# Escribe una sola línea: KD-EJECT:OK, KD-EJECT:VETO:<tipo>:<detalle> o
# KD-EJECT:ERR:<código>:<mensaje>.
#
# Va en un archivo (y no como -EncodedCommand) porque así PowerShell no se pone
# a "preparar módulos": como archivo tarda menos de un segundo, codificado ~30 s.

param(
  [ValidatePattern('^[A-Za-z]$')] [string]$Drive
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KdEject {
  [StructLayout(LayoutKind.Sequential)] struct DeviceNumber { public int DeviceType; public int Number; public int Partition; }
  [StructLayout(LayoutKind.Sequential)] struct DevInfoData { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct InterfaceData { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, int inSize, out DeviceNumber outBuf, int outSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiGetClassDevsW(ref Guid g, IntPtr enumerator, IntPtr parent, int flags);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr devInfo, ref Guid g, int index, ref InterfaceData data);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool SetupDiGetDeviceInterfaceDetailW(IntPtr set, ref InterfaceData data, IntPtr detail, int size, out int required, ref DevInfoData info);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("cfgmgr32.dll")] static extern int CM_Get_Parent(out int parent, int devInst, int flags);
  [DllImport("cfgmgr32.dll")]
  static extern int CM_Get_DevNode_Registry_PropertyW(int devInst, int property, out int regType, out int buffer, ref int length, int flags);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  static extern int CM_Request_Device_EjectW(int devInst, out int vetoType, StringBuilder vetoName, int nameLength, int flags);

  const uint IOCTL_STORAGE_GET_DEVICE_NUMBER = 0x2D1080;
  const int CM_DRP_CAPABILITIES = 0x10;
  const int CM_DEVCAP_REMOVABLE = 0x4;
  static readonly IntPtr Invalid = new IntPtr(-1);

  static bool Number(string path, out DeviceNumber n) {
    n = new DeviceNumber();
    IntPtr h = CreateFileW(path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == Invalid) return false;
    try {
      int returned;
      return DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, IntPtr.Zero, 0, out n, Marshal.SizeOf(typeof(DeviceNumber)), out returned, IntPtr.Zero);
    } finally { CloseHandle(h); }
  }

  static bool Removable(int devInst) {
    int type, caps, length = 4;
    return CM_Get_DevNode_Registry_PropertyW(devInst, CM_DRP_CAPABILITIES, out type, out caps, ref length, 0) == 0
      && (caps & CM_DEVCAP_REMOVABLE) != 0;
  }

  public static string Eject(string letter) {
    DeviceNumber vol;
    if (!Number(@"\\.\" + letter + ":", out vol)) return "ERR:missing:No se pudo abrir el disco " + letter + ":.";
    Guid diskClass = new Guid("53f56307-b6bf-11d0-94f2-00a0c91efb8b");
    IntPtr set = SetupDiGetClassDevsW(ref diskClass, IntPtr.Zero, IntPtr.Zero, 0x12);
    if (set == Invalid) return "ERR:error:No se pudo consultar la lista de discos de Windows.";
    int disk = 0;
    try {
      for (int i = 0; disk == 0; i++) {
        InterfaceData data = new InterfaceData();
        data.cbSize = Marshal.SizeOf(typeof(InterfaceData));
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref diskClass, i, ref data)) break;
        DevInfoData info = new DevInfoData();
        info.cbSize = Marshal.SizeOf(typeof(DevInfoData));
        int required;
        SetupDiGetDeviceInterfaceDetailW(set, ref data, IntPtr.Zero, 0, out required, ref info);
        if (required <= 0) continue;
        IntPtr buffer = Marshal.AllocHGlobal(required);
        try {
          Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 8 : 6);
          if (!SetupDiGetDeviceInterfaceDetailW(set, ref data, buffer, required, out required, ref info)) continue;
          string devicePath = Marshal.PtrToStringUni(new IntPtr(buffer.ToInt64() + 4));
          DeviceNumber n;
          if (Number(devicePath, out n) && n.DeviceType == vol.DeviceType && n.Number == vol.Number) disk = info.DevInst;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
    if (disk == 0) return "ERR:error:No se encontró el dispositivo del disco " + letter + ":.";

    int target = 0, current = disk;
    for (int level = 0; level < 6 && current != 0; level++) {
      if (Removable(current)) { target = current; break; }
      int parent;
      if (CM_Get_Parent(out parent, current, 0) != 0) break;
      current = parent;
    }
    if (target == 0) return "ERR:not-removable:Windows no considera este disco extraíble.";

    int veto = 0, cr = 0;
    StringBuilder name = new StringBuilder(512);
    for (int attempt = 0; attempt < 3; attempt++) {
      name.Length = 0;
      cr = CM_Request_Device_EjectW(target, out veto, name, name.Capacity, 0);
      if (cr == 0 && veto == 0) return "OK";
      System.Threading.Thread.Sleep(700);
    }
    // Sin veto pero con CONFIGRET distinto de 0: es un fallo, no un "programa lo usa".
    if (veto == 0) return "ERR:error:Windows no pudo expulsar el disco (código " + cr + ").";
    return "VETO:" + veto + ":" + name.ToString();
  }
}
'@
  'KD-EJECT:' + [KdEject]::Eject($Drive.ToUpper())
} catch {
  'KD-EJECT:ERR:error:' + $_.Exception.Message
}

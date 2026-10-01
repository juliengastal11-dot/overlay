# ---------------------------------------------------------------------------
# Taille physique des écrans, et place de la fenêtre de Claude. Windows seulement.
#
# Lancé par telephones.mjs avant d'ouvrir les téléphones : c'est ce qui permet
# de les dessiner en millimètres, à la taille d'un vrai iPhone, et de les poser
# à côté de la fenêtre de Claude plutôt que dessus.
#
# La taille vient de l'EDID de chaque moniteur, la fiche qu'il transmet à la
# carte graphique : largeur et hauteur de l'image en millimètres. Windows la
# donne par WMI sans droits d'administrateur.
#
# Sortie : une ligne JSON.
#   { "ecrans": [ { x, y, l, h, mmL, mmH, modele } ], "claude": { x, y, l, h } | null }
# Tout en pixels physiques ; mmL et mmH suivent l'orientation actuelle de l'écran.
# ---------------------------------------------------------------------------
$ErrorActionPreference = "SilentlyContinue"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EcransNatifs {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr contexte);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PERIPHERIQUE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string peripherique, uint numero, ref PERIPHERIQUE p, uint options);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr fenetre, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr fenetre);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr fenetre);

  // Le chemin d'interface du moniteur branché sur cette sortie :
  // \\?\DISPLAY#AOC2590#5&26294c88&0&UID4357#{...}
  public static string Moniteur(string sortie) {
    PERIPHERIQUE p = new PERIPHERIQUE();
    p.cb = Marshal.SizeOf(p);
    return EnumDisplayDevices(sortie, 0, ref p, 1) ? p.DeviceID : "";
  }
}
"@

# Coordonnées physiques, sans la mise à l'échelle de Windows : -4 = conscience
# de la densité par écran (v2), pour ce fil d'exécution.
[void][EcransNatifs]::SetThreadDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms

# EDID de chaque moniteur actif, indexé par « MODELE#INSTANCE ».
$edid = @{}
foreach ($m in Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorDescriptorMethods) {
  $r = Invoke-CimMethod -InputObject $m -MethodName WmiGetMonitorRawEEdidV1Block -Arguments @{ BlockId = [byte]0 }
  $b = $r.BlockContent
  if (-not $b -or $b.Count -lt 72) { continue }
  # Premier descripteur de synchronisation : taille de l'image en mm, résolution native.
  $mmL = $b[66] + (($b[68] -band 0xF0) -shl 4)
  $mmH = $b[67] + (($b[68] -band 0x0F) -shl 8)
  $pxL = $b[56] + (($b[58] -band 0xF0) -shl 4)
  $pxH = $b[59] + (($b[61] -band 0xF0) -shl 4)
  # Repli : la taille maximale de l'image, au centimètre près.
  if ($mmL -le 0 -or $mmH -le 0) { $mmL = 10 * $b[21]; $mmH = 10 * $b[22] }
  $cle = ($m.InstanceName -replace '^DISPLAY\\', '' -replace '_\d+$', '' -replace '\\', '#').ToUpperInvariant()
  $edid[$cle] = @{ mmL = [int]$mmL; mmH = [int]$mmH; pxL = [int]$pxL; pxH = [int]$pxH }
}

$ecrans = @()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $chemin = [EcransNatifs]::Moniteur($s.DeviceName)
  $cle = ""
  if ($chemin -match '^\\\\\?\\DISPLAY#([^#]+#[^#]+)#') { $cle = $Matches[1].ToUpperInvariant() }
  $e = $edid[$cle]
  $mmL = 0; $mmH = 0
  if ($e) {
    $mmL = $e.mmL; $mmH = $e.mmH
    # Un écran tourné d'un quart de tour : l'EDID décrit toujours l'image native.
    if ((($s.Bounds.Width -gt $s.Bounds.Height) -ne ($mmL -gt $mmH)) -and $mmL -ne $mmH) { $t = $mmL; $mmL = $mmH; $mmH = $t }
  }
  $ecrans += [ordered]@{
    x = $s.Bounds.X; y = $s.Bounds.Y; l = $s.Bounds.Width; h = $s.Bounds.Height
    mmL = $mmL; mmH = $mmH; modele = ($cle -split '#')[0]; principal = $s.Primary
  }
}

# La fenêtre de l'application Claude, si elle est ouverte et pas réduite.
$claude = $null
foreach ($p in Get-Process -Name claude) {
  $f = $p.MainWindowHandle
  if ($f -eq [IntPtr]::Zero -or -not [EcransNatifs]::IsWindowVisible($f) -or [EcransNatifs]::IsIconic($f)) { continue }
  $r = New-Object EcransNatifs+RECT
  if ([EcransNatifs]::GetWindowRect($f, [ref]$r)) {
    $claude = [ordered]@{ x = $r.Left; y = $r.Top; l = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
    break
  }
}

[ordered]@{ ecrans = @($ecrans); claude = $claude } | ConvertTo-Json -Compress -Depth 4

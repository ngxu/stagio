# Draws the Stagio icon (two screens: red program, green preview) and writes every size needed:
#   build/icon.png (1024, macOS + electron-builder), build/icon.ico (Windows),
#   public/icons/*.png (phone home screen, browser tab).
# Run: powershell -ExecutionPolicy Bypass -File build/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

function RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw([int]$size, [bool]$fullBleed) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 1024.0
  $bg = [System.Drawing.ColorTranslator]::FromHtml('#121416')
  if ($fullBleed) { $g.Clear($bg) }   # phone home screens add their own mask
  else { $g.FillPath((New-Object System.Drawing.SolidBrush $bg), (RoundedRect (40*$s) (40*$s) (944*$s) (944*$s) (210*$s))) }
  $black = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)
  # program monitor
  $g.FillPath($black, (RoundedRect (150*$s) (300*$s) (600*$s) (338*$s) (28*$s)))
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#E5484D')), (40*$s)), (RoundedRect (150*$s) (300*$s) (600*$s) (338*$s) (28*$s)))
  # preview monitor
  $g.FillPath($black, (RoundedRect (560*$s) (556*$s) (314*$s) (178*$s) (20*$s)))
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#3DD68C')), (28*$s)), (RoundedRect (560*$s) (556*$s) (314*$s) (178*$s) (20*$s)))
  $g.Dispose()
  return $bmp
}

function SavePng($bmp, $path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

SavePng (Draw 1024 $false) (Join-Path $root 'build\icon.png')
SavePng (Draw 512 $true) (Join-Path $root 'public\icons\icon-512.png')
SavePng (Draw 192 $true) (Join-Path $root 'public\icons\icon-192.png')
SavePng (Draw 180 $true) (Join-Path $root 'public\icons\apple-touch-icon.png')
SavePng (Draw 64 $false) (Join-Path $root 'public\icons\favicon.png')

# .ico with PNG-compressed images (valid on Windows Vista and later)
$sizes = 256, 128, 64, 48, 32, 16
$images = foreach ($sz in $sizes) { $ms = New-Object IO.MemoryStream; (Draw $sz $false).Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); ,$ms.ToArray() }
$out = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]; $len = $images[$i].Length
  $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $root 'build\icon.ico'), $out.ToArray())
'icons written'

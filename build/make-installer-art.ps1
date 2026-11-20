# Draws the picture on the left of the installer's last page (build/installer-side.bmp):
# the console's dark surface, the Stagio icon and its name. Replaces NSIS's stock picture.
# Drawn at 125% (205 x 392); Windows scales it to the page's size on other displays.
# Run: powershell -ExecutionPolicy Bypass -File build/make-installer-art.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$w = 205; $h = 392

$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#131516'))   # --surface

# a hairline on the right edge, where the panel meets the white page
$line = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#24272a')), 1
$g.DrawLine($line, $w - 1, 0, $w - 1, $h)

# the icon
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'build\icon.png'))
$size = 104
$g.DrawImage($icon, [int](($w - $size) / 2), 74, $size, $size)
$icon.Dispose()

# the name, and a quiet line under it
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$name = New-Object System.Drawing.Font 'Segoe UI Semibold', 17, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$small = New-Object System.Drawing.Font 'Segoe UI', 11, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$text = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#d8dbde'))
$dim = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#858b91'))
$g.DrawString('Stagio', $name, $text, (New-Object System.Drawing.RectangleF 0, 196, $w, 26), $fmt)
$dot = [string][char]0x00B7   # written as a code: PowerShell 5.1 would misread it in this (BOM-less) file
$g.DrawString("Slides $dot music $dot output", $small, $dim, (New-Object System.Drawing.RectangleF 0, 224, $w, 18), $fmt)

$g.Dispose()
$out = Join-Path $root 'build\installer-side.bmp'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()
"written $out"

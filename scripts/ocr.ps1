param([switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
$asyncMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Result($Operation, [Type]$ResultType) {
    $task = $asyncMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}
try {
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    if ($Check) {
        @{ available = $languages.Count -gt 0; languages = $languages; engine = 'windows-local' } | ConvertTo-Json -Compress
        exit 0
    }
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $languageTag = $languages | Where-Object { $_ -like 'zh-Hans*' } | Select-Object -First 1
    if (-not $languageTag) { $languageTag = $languages | Select-Object -First 1 }
    if (-not $languageTag) { throw 'No installed OCR language' }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($languageTag))
    $bytes = [Convert]::FromBase64String($inputData.image)
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
    $writer.WriteBytes($bytes)
    $null = Await-Result $writer.StoreAsync() ([UInt32])
    $null = $writer.DetachStream()
    $stream.Seek(0)
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ([double]$decoder.PixelWidth * $decoder.PixelHeight -gt 50000000) { throw 'Image exceeds 50 million pixels' }
    $scale = [Math]::Min(1.0, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [double][Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
    $transform = [Windows.Graphics.Imaging.BitmapTransform,Windows.Foundation,ContentType=WindowsRuntime]::new()
    $transform.ScaledWidth = [UInt32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $scale))
    $transform.ScaledHeight = [UInt32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $scale))
    $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = (@($result.Lines | ForEach-Object { $_.Text }) -join "`n").Trim()
    @{ text = $text; language = $languageTag; engine = 'windows-local' } | ConvertTo-Json -Compress
} catch {
    @{ error = 'Local OCR could not decode or recognize this image' } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($writer) { $writer.Dispose() }
    if ($stream) { $stream.Dispose() }
}

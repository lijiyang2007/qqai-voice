# 用 Windows 自带 System.Speech 把一段文字合成为 WAV（离线兜底，见 src/tts-core.js）。
#
# 为什么单独放一个脚本：文字里可能带引号、换行、中文全角符号，
# 直接拼进 -Command 会被引号和代码页吃掉。这里统一从 UTF-8 文件读原文。
#
# 参数：
#   -TextFile   必填，UTF-8 文本文件
#   -OutFile    必填，输出 WAV（16kHz / 16bit / 单声道，QQ 语音转码最省事）
#   -VoiceName  可选，SAPI 音色名（空 = 选第一个中文音色）
#   -Rate       可选，-10 ~ 10（SAPI 的语速刻度）

param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$VoiceName = '',
    [int]$Rate = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) {
    Write-Error 'text is empty'
    exit 2
}

$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    if ($VoiceName) {
        $synth.SelectVoice($VoiceName)
    }
    else {
        $zh = $synth.GetInstalledVoices() |
            Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } |
            Select-Object -First 1
        if ($zh) { $synth.SelectVoice($zh.VoiceInfo.Name) }
    }

    $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))

    # 16kHz/16bit/单声道：SnowLuma 会再转 SILK，源音频规格统一一点更稳。
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $synth.SetOutputToWaveFile($OutFile, $format)
    $synth.Speak($text)
}
finally {
    $synth.Dispose()
}

if (-not (Test-Path -LiteralPath $OutFile)) {
    Write-Error 'no wav produced'
    exit 3
}

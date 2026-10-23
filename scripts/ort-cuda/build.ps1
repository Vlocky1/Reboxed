# Rebuilds vendor/ort-cuda/onnxruntime_binding.node: the official onnxruntime-node 1.30.0 binding
# (js/node/src at tag v1.30.0) compiled with USE_CUDA and linked against the official onnxruntime
# GPU package (CUDA 13). Needs the Visual Studio Build Tools (C++ workload: MSVC, Windows SDK, CMake).
#   powershell -ExecutionPolicy Bypass -File scripts\ort-cuda\build.ps1
$ErrorActionPreference = 'Stop'
$ver = '1.30.0'
$here = $PSScriptRoot
$work = Join-Path $env:TEMP 'reboxed-ort-cuda'
$repo = Resolve-Path (Join-Path $here '..\..')
New-Item -ItemType Directory -Force "$work\src", "$work\inc\core\providers\cuda", "$work\inc\core\framework" | Out-Null

# Binding sources and the two headers the CUDA path needs, at the release tag.
$raw = "https://raw.githubusercontent.com/microsoft/onnxruntime/v$ver"
$files = 'common.h','inference_session_wrap.cc','inference_session_wrap.h','main.cc','ort_instance_data.cc','ort_instance_data.h',
  'ort_singleton_data.cc','ort_singleton_data.h','run_options_helper.cc','run_options_helper.h','session_options_helper.cc',
  'session_options_helper.h','tensor_helper.cc','tensor_helper.h'
foreach ($f in $files) { curl.exe -sfL -o "$work\src\$f" "$raw/js/node/src/$f"; if ($LASTEXITCODE) { throw "download $f" } }
curl.exe -sfL -o "$work\inc\core\providers\cuda\cuda_provider_options.h" "$raw/include/onnxruntime/core/providers/cuda/cuda_provider_options.h"
curl.exe -sfL -o "$work\inc\core\framework\arena_extend_strategy.h" "$raw/onnxruntime/core/framework/arena_extend_strategy.h"

# The official GPU package (headers + onnxruntime.lib).
$zip = "$work\ort-gpu.zip"
if (-not (Test-Path $zip)) { curl.exe -sfL -o $zip "https://github.com/microsoft/onnxruntime/releases/download/v$ver/onnxruntime-win-x64-gpu_cuda13-$ver.zip" }
if (-not (Test-Path "$work\ort")) { Expand-Archive $zip "$work\ort" }
$ort = (Get-ChildItem "$work\ort" -Directory | Select-Object -First 1).FullName -replace '\\', '/'

Copy-Item "$here\CMakeLists.txt", "$here\package.json" $work -Force
Push-Location $work
try {
  npm install --no-audit --no-fund | Out-Null
  $vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath
  $cmake = "$vs\Common7\IDE\CommonExtensions\Microsoft\CMake"
  $electron = (Get-Content "$repo\node_modules\electron\package.json" | ConvertFrom-Json).version
  # cmake-js through node (not npx: npx puts the npm package "rc" before Microsoft's rc.exe).
  cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && set `"PATH=$cmake\CMake\bin;$cmake\Ninja;%PATH%`" && node node_modules\cmake-js\bin\cmake-js compile --runtime electron --runtime-version $electron --arch x64 -G Ninja -O build --config Release `"--CDORT_DIR=$ort`""
  if ($LASTEXITCODE) { throw 'build failed' }
  Copy-Item "$work\build\onnxruntime_binding.node" "$repo\vendor\ort-cuda\onnxruntime_binding.node" -Force
  Write-Host "vendor\ort-cuda\onnxruntime_binding.node rebuilt"
} finally { Pop-Location }

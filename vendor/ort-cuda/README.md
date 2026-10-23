# onnxruntime-node binding with CUDA (NVIDIA stem engine)

`onnxruntime_binding.node` is the official onnxruntime-node **1.30.0** Node-API binding
(`js/node/src` at tag `v1.30.0`, MIT, Microsoft) compiled with `USE_CUDA=1` and linked against the
official onnxruntime GPU package `onnxruntime-win-x64-gpu_cuda13-1.30.0`. The npm package only
builds the CUDA execution provider for Linux; on Windows it has the CPU, DirectML and WebGPU.

Nothing else is shipped with Reboxed. When the user installs the NVIDIA engine
(Preferences > Stems), Reboxed downloads into `<app folder>/engines/nvidia-cuda`:

- `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll` from
  Microsoft's GitHub release (MIT);
- the CUDA runtime, cuBLAS, cuFFT and cuDNN DLLs from NVIDIA's official PyPI packages (NVIDIA
  license), pinned versions, each checked against its SHA-256;
- this binding and the JavaScript part of onnxruntime-node (copied from Reboxed itself).

The stem process for the `cuda` engine runs with that folder in front of `PATH` and loads this
onnxruntime instead of the bundled one (see `src/main/nvidia-engine.js`).

Rebuild: `powershell -ExecutionPolicy Bypass -File scripts\ort-cuda\build.ps1` (Visual Studio Build
Tools with the C++ workload).

# onnxruntime-node 1.30.0 binding with the CUDA execution provider (Windows x64), for Reboxed's
# NVIDIA stem engine. Same sources as the official binding (js/node/src at v1.30.0), linked against
# the official onnxruntime GPU package (onnxruntime-win-x64-gpu_cuda13-1.30.0).
cmake_minimum_required(VERSION 3.15)
project(onnxruntime_binding_cuda)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

add_compile_definitions(NAPI_VERSION=6 ORT_API_MANUAL_INIT USE_CUDA=1 NOMINMAX)

if(NOT ORT_DIR)
  message(FATAL_ERROR "set -DORT_DIR=<onnxruntime-win-x64-gpu_cuda13-1.30.0>")
endif()

include_directories(${CMAKE_JS_INC} ${ORT_DIR}/include ${CMAKE_SOURCE_DIR}/inc ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api)
file(GLOB SOURCES ${CMAKE_SOURCE_DIR}/src/*.cc)
add_library(onnxruntime_binding SHARED ${SOURCES} ${CMAKE_JS_SRC})
set_target_properties(onnxruntime_binding PROPERTIES PREFIX "" SUFFIX ".node")
target_link_directories(onnxruntime_binding PRIVATE ${ORT_DIR}/lib)
target_link_libraries(onnxruntime_binding PRIVATE ${CMAKE_JS_LIB} onnxruntime delayimp)
# Node-API symbols come from the host process (Reboxed.exe / electron.exe), resolved by the delay-load hook.
target_link_options(onnxruntime_binding PRIVATE /DELAYLOAD:node.exe)

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()

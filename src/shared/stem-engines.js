// Engines the stem models can run on, and how Auto picks one.

/** The CPU, or the GPU through WebGPU (Direct3D 12 / Vulkan) or DirectML (Windows). */
export const STEM_ENGINES = ['cpu', 'webgpu', 'dml'];

export const ENGINE_NAMES = { cpu: 'CPU', webgpu: 'GPU · WebGPU', dml: 'GPU · DirectML' };

/**
 * The engine to use for a model: the one chosen, or with 'auto' the fastest one measured on this
 * computer (bench: {cpu: x real time, webgpu: …, dml: … | 'crash' | 'error'}), which must beat the
 * CPU by 10 % (a GPU that is only as fast is not worth its risks). Without measurements, the CPU.
 */
export function pickEngine(choice, bench) {
  if (choice && choice !== 'auto') return choice;
  const cpu = typeof bench?.cpu === 'number' ? bench.cpu : null;
  if (cpu === null) return 'cpu';
  let best = 'cpu'; let bestSpeed = cpu * 1.1;
  for (const ep of STEM_ENGINES) {
    const v = bench?.[ep];
    if (ep !== 'cpu' && typeof v === 'number' && v > bestSpeed) { best = ep; bestSpeed = v; }
  }
  return best;
}

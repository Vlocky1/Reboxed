// worker_thread: encodes one stem to MP3 (the stem process runs the 4 stems in parallel).
import { parentPort, workerData } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';
import { encodeMp3 } from '../shared/mp3.js';

const { pcm, rate, kbps, path } = workerData;
await writeFile(path, encodeMp3(new Int16Array(pcm), rate, kbps));
parentPort.postMessage('ok');

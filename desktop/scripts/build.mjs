import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mainOptions, preloadOptions } from './build-main.mjs';

await Promise.all([esbuild({ ...mainOptions, sourcemap: false }), esbuild({ ...preloadOptions, sourcemap: false })]);
await viteBuild();
console.log('\nBuild complete: dist/ (renderer) + dist-electron/ (main, preload)');

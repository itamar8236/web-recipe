import js from '@eslint/js';
import globals from 'globals';

// The Worker runs on the Workers runtime (web APIs, no Node built-ins); the scripts in
// scripts/ run on Node on the owner's computer.
export default [
  { ignores: ['.wrangler/', 'node_modules/'] },
  js.configs.recommended,
  { files: ['src/**/*.js', 'test/**/*.js'], languageOptions: { globals: { ...globals.serviceworker, FixedLengthStream: 'readonly' } } },
  { files: ['scripts/**/*.mjs', '*.mjs'], languageOptions: { globals: globals.node } },
];

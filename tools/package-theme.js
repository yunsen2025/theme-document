const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the directory stable so WordPress recognizes an update to the active theme.
const themeDirectory = 'theme-document-todo-ux-20261013';
const outputDirectory = path.join(os.homedir(), 'Downloads');
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const outputPath = path.join(outputDirectory, `${themeDirectory}-${timestamp}.zip`);

fs.mkdirSync(outputDirectory, { recursive: true });
execFileSync('git', [
  'archive',
  '--format=zip',
  `--prefix=${themeDirectory}/`,
  'HEAD',
  '-o',
  outputPath,
], { stdio: 'inherit' });

console.log(`Created ${outputPath}`);

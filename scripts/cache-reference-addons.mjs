import { promises as fs } from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const outRoot = path.join(repoRoot, '.reference-addons');

const sources = [
  {
    name: 'claude-code-vscode',
    root: '/home/e/.vscode/extensions/anthropic.claude-code-2.1.177-linux-x64',
    files: [
      'package.json',
      'README.md',
      'webview/index.css',
      'webview/index.js'
    ]
  },
  {
    name: 'codex-vscode',
    root: '/home/e/.vscode/extensions/openai.chatgpt-26.5609.30741-linux-x64',
    files: [
      'package.json',
      'webview/assets/patch-item-content-CkHhct1S.js',
      'webview/assets/diff-unified-9K-hJJMt.js',
      'webview/assets/diff-unified-updTK7TW.css',
      'webview/assets/file-diff-aJzDRNwM.js',
      'webview/assets/prompt-editor-DqEG2JY9.js',
      'webview/assets/user-formatted-text-COqPi9LU.js',
      'webview/assets/user-message-attachments-CxuoHau6.css'
    ]
  }
];

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function formatContent(filePath, raw) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    return JSON.stringify(JSON.parse(raw), null, 2) + '\n';
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const result = await esbuild.transform(raw, {
      loader: 'js',
      format: 'esm',
      legalComments: 'inline'
    });
    return result.code.trimEnd() + '\n';
  }
  if (ext === '.css') {
    const result = await esbuild.transform(raw, {
      loader: 'css',
      legalComments: 'inline'
    });
    return result.code.trimEnd() + '\n';
  }
  return raw;
}

async function writeFormattedCopy(sourceRoot, relativeFile, targetRoot) {
  const sourcePath = path.join(sourceRoot, relativeFile);
  if (!(await exists(sourcePath))) {
    throw new Error(`Missing source file: ${sourcePath}`);
  }
  const raw = await fs.readFile(sourcePath, 'utf8');
  const formatted = await formatContent(sourcePath, raw);
  const targetPath = path.join(targetRoot, relativeFile);
  await ensureDir(targetPath);
  await fs.writeFile(targetPath, formatted, 'utf8');
  return { relativeFile, sourcePath, targetPath };
}

async function main() {
  await fs.mkdir(outRoot, { recursive: true });
  const manifest = [];

  for (const source of sources) {
    const targetRoot = path.join(outRoot, source.name);
    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(targetRoot, { recursive: true });

    const copied = [];
    for (const relativeFile of source.files) {
      copied.push(await writeFormattedCopy(source.root, relativeFile, targetRoot));
    }

    const sourceMap = copied.map((entry) => ({
      file: entry.relativeFile,
      source: entry.sourcePath
    }));
    await fs.writeFile(
      path.join(targetRoot, 'MANIFEST.json'),
      JSON.stringify(
        {
          name: source.name,
          generatedAt: new Date().toISOString(),
          sourceRoot: source.root,
          files: sourceMap
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    manifest.push({ name: source.name, targetRoot, files: sourceMap.length });
  }

  await fs.writeFile(
    path.join(outRoot, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), addons: manifest }, null, 2) + '\n',
    'utf8'
  );

  console.log(`Cached ${manifest.length} addon study bundles into ${outRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

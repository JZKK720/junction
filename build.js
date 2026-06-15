const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
    minify: false,
    target: 'node16',
};

async function build() {
    try {
        if (watch) {
            const ctx = await esbuild.context(buildOptions);
            await ctx.watch();
            console.log('Watching for changes...');
        } else {
            await esbuild.build(buildOptions);
            console.log('Build complete!');
            // Deploy to installed extension directory so VS Code picks it up
            const { execSync } = require('child_process');
            const fs = require('fs');
            const extDir = `${process.env.HOME}/.vscode/extensions`;
            const dests = fs.existsSync(extDir)
                ? fs.readdirSync(extDir).filter((d) => d.toLowerCase().startsWith('plaer1.junction')).map((d) => `${extDir}/${d}`)
                : [];
            for (const dest of dests) {
                execSync(`cp dist/extension.js ${dest}/dist/extension.js`);
                execSync(`cp dist/extension.js.map ${dest}/dist/extension.js.map`);
                execSync(`cp package.json ${dest}/package.json`);
                execSync(`cp -r resources/* ${dest}/resources/`);
                console.log('Deployed to', dest);
            }
        }
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();

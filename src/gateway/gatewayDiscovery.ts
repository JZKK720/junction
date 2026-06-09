import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export interface DiscoveredGateway {
    displayName: string;
    url: string;
    host: string;
    port: number;
    tls: boolean;
    configPath: string;
}

/**
 * Discover running OpenClaw gateways on this machine via lock files.
 *
 * Each running gateway writes /tmp/openclaw-{uid}/gateway.*.lock containing:
 *   { pid, configPath, createdAt, startTime }
 *
 * We read that, check the process is alive, read the config at configPath
 * to get gateway.port, then return ws://127.0.0.1:{port}.
 *
 * Display name is the dotdir basename with the leading dot stripped:
 *   /home/e/.ling/openclaw.json  →  "ling"
 *   /home/e/.testLing/openclaw.json  →  "testLing"
 */
export async function discoverGateways(_timeoutMs = 3000): Promise<DiscoveredGateway[]> {
    const uid = os.userInfo().uid;
    const lockDir = path.join(os.tmpdir(), `openclaw-${uid}`);

    let lockFiles: string[];
    try {
        const entries = await fs.readdir(lockDir);
        lockFiles = entries
            .filter(e => e.startsWith('gateway.') && e.endsWith('.lock'))
            .map(e => path.join(lockDir, e));
    } catch {
        return [];
    }

    const results = await Promise.all(lockFiles.map(readLockFile));
    return results.filter((r): r is DiscoveredGateway => r !== null);
}

async function readLockFile(lockPath: string): Promise<DiscoveredGateway | null> {
    try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const lock: { pid: number; configPath: string } = JSON.parse(raw);

        if (!lock.pid || !lock.configPath) return null;

        // Verify the process is still alive
        const alive = await isPidAlive(lock.pid);
        if (!alive) return null;

        // Read the gateway config
        const configRaw = await fs.readFile(lock.configPath, 'utf-8');
        const config = JSON.parse(configRaw);
        const port: number | undefined = config?.gateway?.port;
        if (!port || typeof port !== 'number') return null;

        // Display name from the dot-directory: /home/e/.ling/openclaw.json → "ling"
        const dirName = path.basename(path.dirname(lock.configPath));
        const displayName = dirName.startsWith('.') ? dirName.slice(1) : dirName;

        return {
            displayName,
            url: `ws://127.0.0.1:${port}`,
            host: '127.0.0.1',
            port,
            tls: false,
            configPath: lock.configPath,
        };
    } catch {
        return null;
    }
}

function isPidAlive(pid: number): Promise<boolean> {
    return new Promise(resolve => {
        execFile('kill', ['-0', String(pid)], err => resolve(!err));
    });
}

import type { PluginOption, ResolvedConfig } from 'vite';
import path from 'path';
import fs from 'fs';

const GHOST_ADMIN_PATH = path.resolve(__dirname, '../../ghost/core/core/built/admin');

function normalizeBuildPermissions(directory: string): void {
  fs.chmodSync(directory, 0o755);

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeBuildPermissions(entryPath);
    } else if (entry.isFile()) {
      fs.chmodSync(entryPath, 0o644);
    }
  }
}

// Ghost core serves the admin from core/built/admin (index.html + assets/).
export function builtAdminPlugin() {
  let config: ResolvedConfig;

  return {
    name: 'built-admin',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    closeBundle() {
      if (config.command !== 'build') {
        return;
      }
      fs.rmSync(GHOST_ADMIN_PATH, { recursive: true, force: true });
      fs.cpSync(config.build.outDir, GHOST_ADMIN_PATH, { recursive: true });

      // Nx preserves output modes in its local and remote caches. Normalize
      // both declared outputs so a cache entry created with a restrictive
      // umask remains readable when restored by another user or in Docker.
      normalizeBuildPermissions(config.build.outDir);
      normalizeBuildPermissions(GHOST_ADMIN_PATH);
    },
  } as const satisfies PluginOption;
}

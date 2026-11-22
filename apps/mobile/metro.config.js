// pnpm keeps every workspace package in its own node_modules, and this app lives two levels down
// from the pnpm workspace root, so Metro is told both places to look and to watch the repo root.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// One React for the whole bundle: packages that do not declare React as a peer (expo-router,
// expo-modules-core) resolve it through pnpm's hidden hoist, which can point at the web app's
// React 18 after any install. Resolving it from this app pins every importer to its React 19.
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    moduleName === 'react' || moduleName.startsWith('react/') ? { ...context, originModulePath: path.join(projectRoot, 'index.ts') } : context,
    moduleName,
    platform,
  );
// The bundled noVNC page is a single self-contained HTML file loaded by the computer viewer's WebView.
config.resolver.assetExts = [...config.resolver.assetExts, 'html'];

module.exports = config;

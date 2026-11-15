/**
 * electron-builder afterPack hook.
 *
 * Without a Developer ID certificate (local `pack`, or a release run with no signing secrets)
 * electron-builder skips signing, which leaves Electron's linker signature on a bundle whose
 * Info.plist and resources it has since changed. Apple silicon then refuses a downloaded copy
 * as "damaged". An ad-hoc signature over the whole bundle fixes that: macOS still says the
 * developer is unidentified (right-click → Open the first time), but the app runs.
 *
 * No hardened runtime here: with an ad-hoc identity there is no Team ID, so library validation
 * would refuse to load Electron's own frameworks ("different Team IDs") and the app would crash
 * at launch. The hardened runtime is only needed for notarization, which needs a real identity.
 *
 * When a certificate is configured (CSC_LINK / CSC_NAME), electron-builder signs properly
 * after this hook and replaces the ad-hoc signature.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, '..', 'assets', 'entitlements.mac.plist');
  console.log(`  • ad-hoc signing  app=${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};

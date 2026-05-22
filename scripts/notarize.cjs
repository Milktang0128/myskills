/**
 * electron-builder `afterSign` hook — submits the freshly-signed .app to
 * Apple's notary service, waits for the verdict, and staples the resulting
 * ticket so the app launches cleanly even when the user is offline.
 *
 * Wired in package.json:
 *   "build": { "afterSign": "scripts/notarize.cjs" }
 *
 * Required env vars (read from process.env, typically loaded from .env.local
 * via `npm run package:signed`):
 *   APPLE_API_KEY        Absolute path to the AuthKey_<KEY_ID>.p8 file
 *   APPLE_API_KEY_ID     The 10-char key ID (visible in the filename)
 *   APPLE_API_ISSUER     The UUID issuer ID from App Store Connect
 *
 * If any of these are missing, we SKIP notarization with a warning. That
 * way `npm run package` (no env) still builds a runnable .app for local
 * testing — it just won't pass Gatekeeper on machines it wasn't built on.
 *
 * notarytool (not the old altool) is used implicitly by @electron/notarize
 * v2+ — it's the only path Apple supports as of November 2023.
 */
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;

  if (!apiKey || !apiKeyId || !apiIssuer) {
    console.warn(
      '[notarize] Skipping: APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER not set.\n' +
        '           This .app is signed but NOT notarized — Gatekeeper on other Macs will block it.\n' +
        '           Run via `npm run package:signed` after filling in .env.local.',
    );
    return;
  }

  console.log(`[notarize] Submitting ${appName}.app to Apple notary service…`);
  console.log('[notarize] This typically takes 1–5 minutes. Do not interrupt.');

  const startedAt = Date.now();
  await notarize({
    tool: 'notarytool',
    appPath,
    appleApiKey: apiKey,
    appleApiKeyId: apiKeyId,
    appleApiIssuer: apiIssuer,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`[notarize] ✓ Notarized and stapled in ${elapsed}s.`);
};

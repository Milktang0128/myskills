import { app, BrowserWindow, session, shell } from 'electron';
import * as path from 'node:path';
import { initPaths } from './paths';
import { initDb } from './db';
import { setSecretStore } from './secrets/safe-storage';
import { electronSafeStorage } from './secrets/electron-safe-storage';
import { setAllowedSender } from './ipc/dispatcher';
import { registerAllHandlers } from './ipc';
import { makeScanProgressForwarder } from './ipc/scan';
import { maybeAutoScan } from './scanner';
import { recoverPendingBackups } from './sync/backup';
import { cleanupOldBackupsBestEffort } from './sync/backup-cleanup';
import { recoverPendingHistory } from './sync/symlink';

const isDev = process.env.NODE_ENV === 'development';
const DEV_URL = 'http://localhost:4477';

let mainWindow: BrowserWindow | null = null;

// Single-instance lock. Two MySkills instances sharing the same myskills.db
// (and the same skill directories) can race on writes — one starts a plan,
// the other invalidates its DB rows mid-execute. Refuse to launch a second
// instance; instead surface the existing window. Acquired BEFORE whenReady
// so the second process exits immediately without running any FS init.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // User opened MySkills again (e.g. clicked dock icon, double-clicked DMG).
    // Bring the existing window forward instead of starting fresh.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload is bundled by electron/build-preload.mjs with esbuild so it has
      // no `require` of relative siblings, which lets us run under full sandbox.
      sandbox: true,
      webSecurity: true,
    },
  });

  setAllowedSender(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Surface renderer errors to the main-process stdout so we see them in dev logs.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] gone:', details);
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[renderer] preload-error:', preloadPath, error);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] did-fail-load:', code, desc, url);
  });

  if (isDev) {
    await mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    // Compiled layout: dist-electron/electron/main.js ; static export at out/index.html.
    await mainWindow.loadFile(path.join(__dirname, '..', '..', 'out', 'index.html'));
  }
}

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    // Dev: Next.js HMR + RSC requires inline scripts and eval. Production stays strict.
    const csp = isDev
      ? "default-src 'self' http://localhost:4477; script-src 'self' 'unsafe-eval' 'unsafe-inline' http://localhost:4477; style-src 'self' 'unsafe-inline' http://localhost:4477; img-src 'self' data: blob: http://localhost:4477; font-src 'self' data: http://localhost:4477; connect-src 'self' ws://localhost:4477 http://localhost:4477"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

app.whenReady().then(async () => {
  installCsp();
  // Single point where the Electron-owned userData path enters the system.
  // Everything else (db, backups, staging) goes through electron/paths.ts.
  initPaths({ userDataDir: app.getPath('userData') });
  initDb();
  // Same DI pattern as paths: install the platform-specific SecretStore here,
  // and the rest of the codebase talks to the interface in safe-storage.ts.
  setSecretStore(electronSafeStorage);
  // Finish any cross-volume backup operations that were interrupted last
  // launch (power loss, force-quit). Safe to run before any sync handler
  // is registered — it only touches our own backupRoot.
  try {
    recoverPendingBackups();
  } catch (err) {
    console.error('[backup] recoverPendingBackups failed:', err);
  }
  // Mark any sync_history rows still in '_pending_' state as '_interrupted_'.
  // This is the DB-side counterpart to recoverPendingBackups: catches crashes
  // between the executor's pending-INSERT and final UPDATE.
  try {
    recoverPendingHistory();
  } catch (err) {
    console.error('[sync] recoverPendingHistory failed:', err);
  }
  // Sweep backups older than retention (default 30 days). Catches the
  // "user kept MySkills closed for months and just opened it" case so the
  // backups dir doesn't grow unbounded. Errors are logged inside the helper.
  cleanupOldBackupsBestEffort();
  registerAllHandlers();
  await createWindow();
  if (mainWindow) {
    await maybeAutoScan(makeScanProgressForwarder(mainWindow.webContents));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Belt-and-suspenders: block any non-allowed webContents from being created.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

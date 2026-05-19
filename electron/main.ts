import { app, BrowserWindow, session, shell } from 'electron';
import * as path from 'node:path';
import { initDb } from './db';
import { setAllowedSender } from './ipc/dispatcher';
import { registerAllHandlers } from './ipc';
import { maybeAutoScan } from './scanner';

const isDev = process.env.NODE_ENV === 'development';
const DEV_URL = 'http://localhost:4477';

let mainWindow: BrowserWindow | null = null;

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
      // sandbox:true would block preload from requiring its sibling files (shared/ipc-channels).
      // We rely on contextIsolation + nodeIntegration:false + IPC whitelist + CSP for isolation.
      sandbox: false,
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
  initDb();
  registerAllHandlers();
  await createWindow();
  if (mainWindow) await maybeAutoScan(mainWindow.webContents);
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

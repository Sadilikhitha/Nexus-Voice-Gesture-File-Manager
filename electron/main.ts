/** Electron shell: sandboxed renderer, camera/mic only, no network. */
import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';

app.whenReady().then(() => {
  // Only media permissions; everything else denied.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  // Hard "zero cloud": refuse any non-local request even if the CSP were bypassed.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) =>
    cb({ cancel: !/^(file|devtools|chrome-extension|data|blob):|^https?:\/\/localhost/.test(d.url) }));

  const win = new BrowserWindow({
    width: 1440, height: 900, backgroundColor: '#020617', titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  dev ? win.loadURL(dev) : win.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());

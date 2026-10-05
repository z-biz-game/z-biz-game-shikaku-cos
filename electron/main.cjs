// Electron shell. The game is a browser artefact first — this exists so the same files
// run as a desktop app without a bundler or a build step.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#080B16',
    title: '数间 Shikaku',
    // 生成的 512² 真位图：不给 icon 的话 Windows 任务栏与 Linux 的 dock/alt-tab 挂的是
    // Electron 的灰块图标，桌面端看起来就像没做完的脚手架。
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

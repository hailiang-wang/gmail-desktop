import * as fs from 'fs'
import * as path from 'path'
import {
  app,
  ipcMain as ipc,
  shell,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme
} from 'electron'
import { is } from 'electron-util'

import { init as initAutoUpdates } from './updates'
import config, { ConfigKey } from './config'
import {
  init as initCustomStyles,
  USER_CUSTOM_STYLE_PATH
} from './custom-styles'
import { init as initDebug } from './debug'
import { init as initDownloads } from './downloads'
import { platform, getUrlAccountId } from './helpers'
import { initOrUpdateMenu } from './menu'
import {
  setAppMenuBarVisibility,
  cleanURLFromGoogle,
  sendChannelToMainWindow,
  sendChannelToAllWindows
} from './utils'
import ensureOnline from './ensure-online'
import { autoFixUserAgent, removeCustomUserAgent } from './user-agent'

import electronContextMenu = require('electron-context-menu')

initDebug()
initDownloads()
initAutoUpdates()

electronContextMenu({ showCopyImageAddress: true, showSaveImageAs: true })

if (!config.get(ConfigKey.HardwareAcceleration)) {
  app.disableHardwareAcceleration()
}

const shouldStartMinimized =
  app.commandLine.hasSwitch('launch-minimized') ||
  config.get(ConfigKey.LaunchMinimized)

app.setAppUserModelId('io.hailiang-wang.evernote-desktop')

let mainWindow: BrowserWindow
let isQuitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.show()
  }
})

switch (config.get(ConfigKey.DarkMode)) {
  case 'system':
    nativeTheme.themeSource = 'system'
    break
  case true:
    nativeTheme.themeSource = 'dark'
    break
  default:
    nativeTheme.themeSource = 'light'
}

function createWindow(): void {
  const lastWindowState = config.get(ConfigKey.LastWindowState)

  mainWindow = new BrowserWindow({
    title: app.name,
    // TitleBarStyle: config.get(ConfigKey.CompactHeader)
    // ? 'hiddenInset'
    // : 'default',
    // hidden frame and title bar https://www.electronjs.org/zh/docs/latest/api/frameless-window
    titleBarStyle: 'hidden',
    frame: false,
    minWidth: 780,
    width: lastWindowState.bounds.width,
    minHeight: 200,
    height: lastWindowState.bounds.height,
    x: lastWindowState.bounds.x,
    y: lastWindowState.bounds.y,
    webPreferences: {
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload')
    },
    show: !shouldStartMinimized,
    icon: is.linux
      ? path.join(__dirname, '..', 'static', 'icon.png')
      : undefined,
    darkTheme: nativeTheme.shouldUseDarkColors
  })

  // MainWindow.setFullScreen(true);
  // if (lastWindowState.fullscreen && !mainWindow.isFullScreen()) {
  //   mainWindow.setFullScreen(lastWindowState.fullscreen)
  // }

  mainWindow.maximize()
  // If (lastWindowState.maximized && !mainWindow.isMaximized()) {
  //   mainWindow.maximize()
  // }

  if (is.linux || is.windows) {
    setAppMenuBarVisibility()
  }

  mainWindow.loadURL('https://www.evernote.com/Home.action')

  mainWindow.on('app-command', (_event, command) => {
    if (command === 'browser-backward' && mainWindow.webContents.canGoBack()) {
      mainWindow.webContents.goBack()
    } else if (
      command === 'browser-forward' &&
      mainWindow.webContents.canGoForward()
    ) {
      mainWindow.webContents.goForward()
    }
  })

  mainWindow.webContents.on('dom-ready', () => {
    addCustomCSS(mainWindow)
    initCustomStyles()
  })

  mainWindow.webContents.on('did-finish-load', async () => {
    if (mainWindow.webContents.getURL().includes('signin/rejected')) {
      const message = `It looks like you are unable to sign-in, because Gmail is blocking the user agent ${app.name} is using.`
      const askAutoFixMessage = `Do you want ${app.name} to attempt to fix it automatically?`
      const troubleshoot = () => {
        openExternalUrl(
          'https://github.com/timche/gmail-desktop#i-cant-sign-in-this-browser-or-app-may-not-be-secure'
        )
      }

      if (config.get(ConfigKey.CustomUserAgent)) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message,
          detail: `You're currently using a custom user agent. ${askAutoFixMessage} Alternatively you can try the default user agent or set another custom user agent (see "Troubleshoot").`,
          buttons: ['Yes', 'Cancel', 'Use Default User Agent', 'Troubleshoot']
        })

        if (response === 3) {
          troubleshoot()
          return
        }

        if (response === 2) {
          removeCustomUserAgent()
          return
        }

        if (response === 1) {
          return
        }

        return
      }

      const { response } = await dialog.showMessageBox({
        type: 'info',
        message,
        detail: `${askAutoFixMessage} Alternatively you can set a custom user agent (see "Troubleshoot").`,
        buttons: ['Yes', 'Cancel', 'Troubleshoot']
      })

      if (response === 2) {
        troubleshoot()
        return
      }

      if (response === 1) {
        return
      }

      autoFixUserAgent()
    }
  })

  mainWindow.on('close', (error) => {
    if (!isQuitting) {
      error.preventDefault()
      mainWindow.blur()
      mainWindow.hide()
    }
  })
}

function addCustomCSS(windowElement: BrowserWindow): void {
  windowElement.webContents.insertCSS(
    fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8')
  )

  if (fs.existsSync(USER_CUSTOM_STYLE_PATH)) {
    windowElement.webContents.insertCSS(
      fs.readFileSync(USER_CUSTOM_STYLE_PATH, 'utf8')
    )
  }

  const platformCSSFile = path.join(
    __dirname,
    '..',
    'css',
    `style.${platform}.css`
  )
  if (fs.existsSync(platformCSSFile)) {
    windowElement.webContents.insertCSS(
      fs.readFileSync(platformCSSFile, 'utf8')
    )
  }
}

async function openExternalUrl(url: string): Promise<void> {
  const cleanURL = cleanURLFromGoogle(url)

  if (config.get(ConfigKey.ConfirmExternalLinks)) {
    const { origin } = new URL(cleanURL)
    const trustedHosts = config.get(ConfigKey.TrustedHosts)

    if (!trustedHosts.includes(origin)) {
      const { response, checkboxChecked } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Open Link', 'Cancel'],
        message: `Do you want to open this external link in your default browser?`,
        checkboxLabel: `Trust all links on ${origin}`,
        detail: cleanURL
      })

      if (response !== 0) return

      if (checkboxChecked) {
        config.set(ConfigKey.TrustedHosts, [...trustedHosts, origin])
      }
    }
  }

  shell.openExternal(cleanURL)
}

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
  }
})

app.on('before-quit', () => {
  isQuitting = true

  if (mainWindow) {
    config.set(ConfigKey.LastWindowState, {
      bounds: mainWindow.getBounds(),
      fullscreen: mainWindow.isFullScreen(),
      maximized: mainWindow.isMaximized()
    })
  }
})
;(async () => {
  await Promise.all([ensureOnline(), app.whenReady()])

  const customUserAgent = config.get(ConfigKey.CustomUserAgent)

  if (customUserAgent) {
    app.userAgentFallback = customUserAgent
  }

  ipc.handle('dark-mode', () => {
    return nativeTheme.shouldUseDarkColors
  })

  nativeTheme.on('updated', () => {
    sendChannelToAllWindows(
      'dark-mode:updated',
      nativeTheme.shouldUseDarkColors
    )
  })

  createWindow()

  initOrUpdateMenu()

  if (is.macos) {
    if (!config.get(ConfigKey.ShowDockIcon)) {
      app.dock.hide()
    }

    const dockMenu = Menu.buildFromTemplate([
      {
        label: 'Compose',
        click() {
          mainWindow.show()
          sendChannelToMainWindow('compose')
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Inbox',
        click() {
          mainWindow.show()
          sendChannelToMainWindow('inbox')
        }
      },
      {
        label: 'Snoozed',
        click() {
          mainWindow.show()
          sendChannelToMainWindow('snoozed')
        }
      },
      {
        label: 'Sent',
        click() {
          mainWindow.show()
          sendChannelToMainWindow('sent')
        }
      },
      {
        label: 'All Mail',
        click() {
          mainWindow.show()
          sendChannelToMainWindow('all-mail')
        }
      }
    ])

    app.dock.setMenu(dockMenu)
  }

  const { webContents } = mainWindow!

  webContents.on('dom-ready', () => {
    if (!shouldStartMinimized) {
      mainWindow.show()
    }
  })

  // eslint-disable-next-line max-params
  webContents.on('new-window', (event: any, url, _1, _2, options) => {
    event.preventDefault()

    // `Add account` opens `accounts.google.com`
    if (url.startsWith('https://accounts.google.com')) {
      mainWindow.loadURL(url)
      return
    }

    if (url.startsWith('https://mail.google.com')) {
      // Check if the user switches accounts which is determined
      // by the URL: `mail.google.com/mail/u/<local_account_id>/...`
      const currentAccountId = getUrlAccountId(mainWindow.webContents.getURL())
      const targetAccountId = getUrlAccountId(url)

      if (targetAccountId !== currentAccountId) {
        mainWindow.loadURL(url)
        return
      }

      // Center the new window on the screen
      event.newGuest = new BrowserWindow({
        ...options,
        titleBarStyle: 'default',
        x: undefined,
        y: undefined
      })

      event.newGuest.webContents.on('dom-ready', () => {
        addCustomCSS(event.newGuest)
      })

      event.newGuest.webContents.on(
        'new-window',
        (event: Event, url: string) => {
          event.preventDefault()
          openExternalUrl(url)
        }
      )

      return
    }

    if (url.startsWith('about:blank')) {
      const win = new BrowserWindow({
        ...options,
        show: false
      })

      win.webContents.once('will-redirect', (_event, url) => {
        openExternalUrl(url)
        win.destroy()
      })

      event.newGuest = win

      return
    }

    openExternalUrl(url)
  })

  if (config.get(ConfigKey.DarkMode) === undefined) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `${app.name} (now) has dark mode! Do you want to enable it?`,
      detail:
        'It\'s recommended to set the Gmail theme to "Default" in order for dark mode to work properly.',
      buttons: ['Yes', 'No', 'Follow System Appearance', 'Ask Again Later']
    })

    if (response === 0) {
      nativeTheme.themeSource = 'dark'
      config.set(ConfigKey.DarkMode, true)
      initOrUpdateMenu()
    } else if (response === 1) {
      nativeTheme.themeSource = 'light'
      config.set(ConfigKey.DarkMode, false)
      initOrUpdateMenu()
    } else if (response === 2) {
      nativeTheme.themeSource = 'system'
      config.set(ConfigKey.DarkMode, 'system')
      initOrUpdateMenu()
    }
  }
})()

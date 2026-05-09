import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"
import contextMenu from "electron-context-menu"
import type { InitStep, ServerReadyData, SqliteMigrationProgress } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { migrate } from "./migrate"
import {
  allocatePort,
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  spawnWslSidecar,
  type SidecarListener,
} from "./server"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { createWslServersController } from "./wsl-servers"

contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

try {
  process.chdir(homedir())
} catch {}

process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"

const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
const onboardingTestRoot = ((): string | undefined => {
  if (!TEST_ONBOARDING) return

  const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
  rmSync(root, { recursive: true, force: true })
  ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
    mkdirSync(join(root, dir), { recursive: true }),
  )
  process.env.OPENCODE_DB = ":memory:"
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.XDG_CACHE_HOME = join(root, "cache")
  process.env.XDG_STATE_HOME = join(root, "state")
  return root
})()

app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
app.setAppUserModelId(appId)
app.setPath("userData", onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId))
if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
const loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()
const wslServers = createWslServersController(
  app.getVersion(),
  async (distro) => {
    logger.log("spawning wsl sidecar", { distro })
    return spawnWslSidecar(distro, {
      onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
    })
  },
  {
    log: (message, meta) => logger.log(message, meta),
    error: (message, meta) => logger.error(message, meta),
  },
)

useSystemCertificates()

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
  onboardingTest: Boolean(onboardingTestRoot),
})

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    void killSidecar()
    wslServers.stopAll()
  })

  app.on("will-quit", () => {
    void killSidecar()
    wslServers.stopAll()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killSidecar().finally(() => {
        wslServers.stopAll()
        app.exit(0)
      })
    })
  }

  void app.whenReady().then(async () => {
    if (!TEST_ONBOARDING) migrate()
    app.setAsDefaultProtocolClient("opencode")
    registerRendererProtocol()
    setDockIcon()
    setupAutoUpdater()
    await initialize()
  })
}

function useSystemCertificates() {
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize() {
  const needsMigration = !sqliteFileExists()
  let overlay: BrowserWindow | null = null

  const port = await allocatePort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    logger.log("spawning sidecar", { url })
    const { listener, health } = await spawnLocalServer(
      hostname,
      port,
      password,
      () => {
        ensureLoopbackNoProxy()
        useEnvProxy()
      },
      {
        needsMigration,
        userDataPath: app.getPath("userData"),
        onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
        onStdout: (message) => logger.log("sidecar stdout", { message }),
        onStderr: (message) => logger.warn("sidecar stderr", { message }),
        onExit: (code) => logger.warn("sidecar exited", { code }),
      },
    )
    server = listener
    serverReady.resolve({
      url,
      username: "opencode",
      password,
    })

    void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))

    await Promise.race([
      health.wait,
      delay(30_000).then(() => {
        throw new Error("Sidecar health check timed out")
      }),
    ]).catch((error) => {
      logger.error("sidecar health check failed", error)
    })

    logger.log("loading task finished")
  })()

  if (needsMigration) {
    const show = await Promise.race([loadingTask.then(() => false), delay(1_000).then(() => true)])
    if (show) {
      overlay = createLoadingWindow()
      await delay(1_000)
    }
  }

  await loadingTask
  setInitStep({ phase: "done" })

  if (overlay) {
    await loadingComplete.promise
  }

  mainWindow = createMainWindow()
  wireMenu()

  overlay?.close()
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    checkForUpdates: () => {
      void checkForUpdates(true, killSidecar)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => relaunchApp(),
  })
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  relaunch: () => relaunchApp(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getWslServersState: () => wslServers.getState(),
  onWslServersEvent: (listener) => wslServers.subscribe(listener),
  wslServersProbeRuntime: () => wslServers.probeRuntime(),
  wslServersRefreshDistros: () => wslServers.refreshDistros(),
  wslServersInstallWsl: () => wslServers.installWsl(),
  wslServersInstallDistro: (name) => wslServers.installDistro(name),
  wslServersProbeDistro: (name) => wslServers.probeDistro(name),
  wslServersProbeOpencode: (name) => wslServers.probeOpencode(name),
  wslServersInstallOpencode: (name) => wslServers.installOpencode(name),
  wslServersOpenTerminal: (name) => wslServers.openTerminal(name),
  wslServersAddServer: (distro) => wslServers.addServer(distro),
  wslServersRemoveServer: (id) => wslServers.removeServer(id),
  wslServersStartServer: (id) => wslServers.startServer(id),
  getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
  consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode, distro) => wslPath(path, mode, distro),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(killSidecar),
  setBackgroundColor: (color) => setBackgroundColor(color),
})

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function relaunchApp() {
  void killSidecar().finally(() => {
    wslServers.stopAll()
    app.relaunch()
    app.exit(0)
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

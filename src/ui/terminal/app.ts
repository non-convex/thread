import { createCliRenderer, destroyTreeSitterClient, type CliRenderer } from "@opentui/core";
import type { ThreadApp } from "../../app.js";
import { settlesWithin } from "../../utils/async.js";
import { ThreadTuiController } from "./controller.js";
import { mountThreadView } from "./view.js";

export type TerminalMode = "fullscreen";

export interface TerminalAppOptions {
  mode?: TerminalMode;
}

const TERMINAL_RESOURCE_SHUTDOWN_GRACE_MS = 1_000;

/**
 * OpenTUI host for Thread's full-screen terminal experience. Session Tree history,
 * live output, composer and transient screens share one persistent render tree.
 */
export class ThreadTerminalApp {
  private renderer: CliRenderer | undefined;
  private readonly controller: ThreadTuiController;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    app: ThreadApp,
    _options: TerminalAppOptions = {},
  ) {
    this.controller = new ThreadTuiController(app);
  }

  async run(): Promise<void> {
    let disposeResources: (() => void | Promise<void>) | undefined;
    this.renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      externalOutputMode: "passthrough",
      consoleMode: "disabled",
      targetFps: 30,
      maxFps: 60,
      useMouse: true,
      enableMouseMovement: false,
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
      useKittyKeyboard: {
        disambiguate: true,
        alternateKeys: true,
        events: false,
        reportText: true,
      },
      openConsoleOnError: false,
      onDestroy: () => {
        if (!this.controller.isStopped) this.controller.requestStop();
      },
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => this.controller.requestStop();
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    try {
      const mounted = await mountThreadView(this.renderer, this.controller);
      disposeResources = mounted.disposeResources;
      await this.controller.waitUntilStopped();
    } finally {
      this.controller.dispose();
      for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
      this.signalHandlers.clear();
      try {
        if (disposeResources) {
          await settlesWithin(Promise.resolve(disposeResources()), TERMINAL_RESOURCE_SHUTDOWN_GRACE_MS);
        }
        // OpenTUI starts this worker cleanup from renderer.destroy(), but does
        // not await it. Waiting here avoids leaving Bun alive after the screen
        // has already returned to the shell.
        await settlesWithin(destroyTreeSitterClient(), TERMINAL_RESOURCE_SHUTDOWN_GRACE_MS);
      } finally {
        this.renderer?.destroy();
        this.renderer = undefined;
      }
    }
  }
}

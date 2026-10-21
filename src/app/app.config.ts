import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { DemoEngine } from './core/demo-engine';
import { Engine, IN_APP } from './core/engine';
import { TauriEngine } from './core/tauri-engine';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), { provide: Engine, useClass: IN_APP ? TauriEngine : DemoEngine }],
};

/**
 * Hands the settings model built in `apply` (where `configForms` is available) to the 去AI味
 * panel's 设置 view, which is a plain slot component without injected services.
 */
import type { SettingsModel } from './model.ts'
import type { Lang } from './SettingsPage.tsx'

export interface SettingsBridge { model: SettingsModel; lang: () => Lang }

let current: SettingsBridge | undefined
const subs = new Set<() => void>()

export const settingsBridge = {
  get: (): SettingsBridge | undefined => current,
  set(next: SettingsBridge | undefined): void { current = next; for (const fn of subs) fn() },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } },
}

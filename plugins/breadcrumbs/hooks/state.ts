import type { Crumbs } from '../types'
import { asks, dones } from './text'

const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : [])

export const normalize = (value: Partial<Crumbs> | null | undefined): Crumbs => {
  const c = value ?? {}

  return {
    tasks: list(c.tasks),
    prompts: list(c.prompts),
    activity: c.activity ?? null,
    lastSaid: c.lastSaid ?? null,
    notes: list(c.notes),
    decided: list(c.decided),
    tried: list(c.tried),
    needsYou: asks(c.needsYou),
    done: dones(c.done),
    edited: list(c.edited),
    touched: list(c.touched),
    repos: list(c.repos),
    asking: c.asking ?? null,
  }
}

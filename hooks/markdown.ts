import type { Crumbs, Where } from '../types'
import { asks, basename, stamp } from './text'

export type Saved = Crumbs & { session: string; worktree: string; updatedAt: number }

export const contextMarkdown = (saved: Saved, where: Where, status: string): string => {
  const task = saved.tasks[0]?.title ?? 'No task yet'
  const lines = [
    '---',
    `session: ${saved.session}`,
    `worktree: ${saved.worktree}`,
    `repo: ${where.repo}`,
    `branch: ${where.branch}`,
    `status: ${status}`,
    `updated: ${stamp(saved.updatedAt)}`,
    '---',
    '',
    `# ${task}`,
    '',
  ]
  if (saved.tasks.length > 1) {
    lines.push('Earlier in this session:', ...saved.tasks.slice(1).map(t => `- ${t.title}`), '')
  }
  const waiting = asks(saved.needsYou)
  if (waiting.length > 0) lines.push('## Needs you', '', ...waiting.map(a => `- [ ] ${a.question}`), '')
  const prompt = saved.prompts.at(-1)
  if (prompt) lines.push('## You asked', '', ...prompt.text.split('\n').map(l => `> ${l}`), '')
  if (saved.lastSaid) lines.push('## Claude last said', '', saved.lastSaid.text, '')
  if (saved.notes.length > 0) {
    lines.push('## Notes', '', ...saved.notes.map(n => `- [${n.title}](${basename(n.file)})`), '')
  }
  if (saved.decided.length > 0) lines.push('## Decided', '', ...saved.decided.map(d => `- ${d}`), '')
  if (saved.tried.length > 0) {
    lines.push('## Tried', '', ...saved.tried.map(t => `- ${t.isOk ? '✓' : '✗'} ${t.text}`), '')
  }

  return lines.join('\n')
}

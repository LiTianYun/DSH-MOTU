/**
 * The local report library.
 *
 * A report is a snapshot a person may want to keep, copy, or commit next to the
 * project, so storage is deliberately ordinary files:
 *
 *   <workspace>/.dsh/visual-kit/reports/<id>/
 *     report.html   the self-contained page
 *     report.json   the validated spec
 *     meta.json     the summary this index is rebuilt from
 *
 *   ~/.dsh/visual-kit/reports/index.json
 *   ~/.dsh/visual-kit/reports/<id>/...   fallback when no workspace is known
 *
 * Nothing here talks to the network. The index is a cache: `rebuild` can
 * reconstruct it from the `meta.json` files if it is lost or corrupted.
 *
 * @module dsh-visual-kit/reports
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** The per-project directory, relative to the workspace root. */
export const REPORT_DIR = '.dsh/visual-kit/reports'

/** Index format version, so a future migration can refuse an unknown file. */
const INDEX_VERSION = 1

/** How many reports the panel lists by default. */
const LIST_LIMIT = 200

/** A generated id: date-time plus a slice of the content hash. */
const SAFE_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/

/**
 * Pad a number to two digits.
 * @param {number} value - the number.
 * @returns {string} two digits.
 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * The UTC timestamp part of a report id.
 * @param {Date} date - the time.
 * @returns {string} `YYYYMMDD-HHmmss`.
 */
function stamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/**
 * Whether `target` is inside `root` (or equal to it).
 * @param {string} root - the allowed root.
 * @param {string} target - the candidate path.
 * @returns {boolean} true when contained.
 */
function isInside(root, target) {
  const base = resolve(root)
  const value = resolve(target)
  return value === base || value.startsWith(`${base}${sep}`)
}

/**
 * Write a file atomically: temp sibling, then rename.
 * @param {string} file - the destination.
 * @param {string} text - the content.
 * @returns {Promise<void>} resolves after the rename.
 */
async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/**
 * Read a JSON file, returning `fallback` when it is missing or unreadable.
 * @param {string} file - the file.
 * @param {unknown} fallback - the value to use.
 * @returns {Promise<unknown>} the parsed value.
 */
async function readJsonOr(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * The project-local report root for one workspace.
 * @param {string} workspacePath - the workspace root.
 * @returns {string} the report root.
 */
export function projectReportRoot(workspacePath) {
  return join(workspacePath, REPORT_DIR)
}

/**
 * Create a report store bound to one home directory.
 *
 * @param {object} [options] - test seams.
 * @param {string} [options.home] - the home directory.
 * @param {string} [options.globalRoot] - override the fallback root.
 * @param {string} [options.indexPath] - override the index file.
 * @param {() => Date} [options.now] - the clock.
 * @param {{warn?: (message: string) => void}} [options.logger] - diagnostics.
 * @returns {object} the store API.
 */
export function createReportStore(options = {}) {
  const home = options.home ?? homedir()
  const globalRoot = options.globalRoot ?? join(home, '.dsh', 'visual-kit', 'reports')
  const indexPath = options.indexPath ?? join(globalRoot, 'index.json')
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? {}

  /** @type {{version: number, entries: object[]}|null} */
  let cache = null

  /** Whether the last index load came from a readable file rather than a scan. */
  let indexWasPresent = false

  /**
   * Whether an index entry belongs to the same archive destination.
   *
   * Content dedupe is scoped to the destination: the same report generated in
   * two projects should exist in both projects, not collapse into the first one.
   *
   * @param {object} entry - an index entry.
   * @param {object|null} workspace - the requested workspace, or null.
   * @returns {boolean} true when they share a destination.
   */
  function sameArchive(entry, workspace) {
    const wanted = typeof workspace?.path === 'string' && workspace.path !== '' ? resolve(workspace.path) : ''
    if (wanted === '') return entry.root === 'home' || entry.workspace === null || entry.workspace === undefined
    const actual = typeof entry.workspace?.path === 'string' && entry.workspace.path !== '' ? resolve(entry.workspace.path) : ''
    if (actual === '') return false
    return process.platform === 'win32' ? actual.toLowerCase() === wanted.toLowerCase() : actual === wanted
  }

  /**
   * Read the index, rebuilding the in-memory shape when the file is missing.
   *
   * @param {string[]} [workspacePaths] - workspace roots used when the index
   *   has to be reconstructed from `meta.json` files.
   * @returns {Promise<{version: number, entries: object[]}>} the index.
   */
  async function loadIndex(workspacePaths = []) {
    if (cache !== null) return cache
    const parsed = await readJsonOr(indexPath, null)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      indexWasPresent = true
      cache = { version: Number(parsed.version) || INDEX_VERSION, entries: parsed.entries.filter((entry) => entry !== null && typeof entry === 'object') }
    } else {
      // A missing or corrupt index is not fatal: the meta files are the truth.
      indexWasPresent = false
      cache = { version: INDEX_VERSION, entries: await scanEntries(workspacePaths) }
    }
    return cache
  }

  /**
   * Write the index atomically.
   * @param {{version: number, entries: object[]}} index - the index.
   * @returns {Promise<void>} resolves after the write.
   */
  async function saveIndex(index) {
    cache = index
    await writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  }

  /**
   * Scan the global root and known workspace roots for `meta.json` files.
   *
   * @param {string[]} [workspacePaths] - workspace roots to scan.
   * @returns {Promise<object[]>} the entries.
   */
  async function scanEntries(workspacePaths = []) {
    const roots = new Set([globalRoot, ...workspacePaths.map(projectReportRoot)])
    const entries = []
    for (const root of roots) {
      let names = []
      try {
        names = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.isDirectory() || !SAFE_ID.test(name.name)) continue
        const dir = join(root, name.name)
        const meta = await readJsonOr(join(dir, 'meta.json'), null)
        if (meta === null || typeof meta !== 'object') continue
        if (!isInside(root, dir)) continue
        entries.push({ ...meta, id: name.name, dir, base: root })
      }
    }
    entries.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return entries
  }

  /**
   * Write one report's files and return its index entry.
   *
   * @param {object} input - `{ spec, html, style, workspace, sessionId, hash, id, createdAt }`.
   * @param {string} root - the base directory.
   * @param {'project'|'home'} kind - which base this is.
   * @returns {Promise<object>} the entry.
   */
  async function writeReport(input, root, kind) {
    const dir = join(root, input.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.html'), input.html, 'utf8')
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(input.spec, null, 2)}\n`, 'utf8')
    const entry = {
      id: input.id,
      title: String(input.spec?.title ?? '任务报告').slice(0, 200),
      round: String(input.spec?.round ?? '').slice(0, 120),
      status: String(input.spec?.status ?? 'done').slice(0, 20),
      createdAt: input.createdAt,
      hash: input.hash,
      root: kind,
      dir,
      base: root,
      workspace: input.workspace === null ? null : { title: String(input.workspace.title ?? '').slice(0, 120), path: String(input.workspace.path ?? '') },
    }
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify({ ...entry, sessionId: input.sessionId, style: input.style }, null, 2)}\n`, 'utf8')
    return entry
  }

  /**
   * Save one report, deduplicating by content hash.
   *
   * @param {object} input - `{ spec, html, style, workspace, sessionId }`.
   * @returns {Promise<{entry: object, deduped: boolean}>} the stored entry.
   */
  async function save(input) {
    const spec = input?.spec
    const html = String(input?.html ?? '')
    const style = String(input?.style ?? '')
    const workspace = input?.workspace ?? null
    const hash = createHash('sha256').update(JSON.stringify({ spec, style })).digest('hex')
    const index = await loadIndex()
    const existing = index.entries.find((entry) => entry.hash === hash && sameArchive(entry, workspace))
    if (existing !== undefined) {
      try {
        await stat(join(existing.dir, 'report.html'))
        return { entry: existing, deduped: true }
      } catch {
        // The record is stale; fall through and write a fresh copy.
      }
    }
    const createdAt = now().toISOString()
    // The id must also separate destinations: two projects can legitimately
    // receive the same report within the same second.
    const destination = typeof workspace?.path === 'string' && workspace.path !== '' ? resolve(workspace.path) : 'home'
    const id = `${stamp(now())}-${createHash('sha256').update(`${hash}\n${destination}`).digest('hex').slice(0, 8)}`
    const payload = { spec, html, style, workspace, sessionId: String(input?.sessionId ?? ''), hash, id, createdAt }
    let entry
    if (workspace !== null && typeof workspace.path === 'string' && workspace.path !== '') {
      try {
        entry = await writeReport(payload, projectReportRoot(workspace.path), 'project')
      } catch (error) {
        logger.warn?.(`[dsh-visual-kit] 项目报告目录不可写，改存用户目录：${String(error?.message ?? error)}`)
        entry = await writeReport(payload, globalRoot, 'home')
      }
    } else {
      entry = await writeReport(payload, globalRoot, 'home')
    }
    const entries = [entry, ...index.entries.filter((item) => item.id !== entry.id && item.id !== existing?.id)]
    entries.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    await saveIndex({ version: INDEX_VERSION, entries })
    return { entry, deduped: false }
  }

  /**
   * List the reports that still have their page on disk.
   *
   * @param {{limit?: number}} [options] - paging.
   * @returns {Promise<object[]>} newest first.
   */
  async function list(options = {}) {
    const index = await loadIndex(Array.isArray(options.workspacePaths) ? options.workspacePaths : [])
    const limit = Math.max(1, Math.min(LIST_LIMIT, Number(options.limit) || LIST_LIMIT))
    const checks = await Promise.all(index.entries.map(async (entry) => {
      try {
        // The index is local but still untrusted input: never stat a path that
        // escaped its recorded archive root.
        if (!isInside(entry.base ?? globalRoot, entry.dir)) return null
        await stat(join(entry.dir, 'report.html'))
        return entry
      } catch {
        return null
      }
    }))
    return checks.filter((entry) => entry !== null).slice(0, limit)
  }

  /**
   * Read one report page.
   *
   * @param {string} id - the generated id.
   * @returns {Promise<{entry: object, html: string}|null>} the page, or null.
   */
  async function read(id) {
    if (!SAFE_ID.test(String(id))) return null
    const index = await loadIndex()
    const entry = index.entries.find((item) => item.id === id)
    if (entry === undefined) return null
    if (!isInside(entry.base ?? globalRoot, entry.dir)) return null
    try {
      return { entry, html: await readFile(join(entry.dir, 'report.html'), 'utf8') }
    } catch {
      return null
    }
  }

  /**
   * Delete one report and its index entry.
   *
   * @param {string} id - the generated id.
   * @returns {Promise<boolean>} whether anything was removed.
   */
  async function remove(id) {
    if (!SAFE_ID.test(String(id))) return false
    const index = await loadIndex()
    const entry = index.entries.find((item) => item.id === id)
    if (entry === undefined) return false
    if (!isInside(entry.base ?? globalRoot, entry.dir)) return false
    try {
      await rm(entry.dir, { recursive: true, force: true })
    } catch (error) {
      logger.warn?.(`[dsh-visual-kit] 删除报告失败：${String(error?.message ?? error)}`)
      return false
    }
    await saveIndex({ version: INDEX_VERSION, entries: index.entries.filter((item) => item.id !== id) })
    return true
  }

  /**
   * Rebuild the index from the meta files on disk.
   *
   * @param {string[]} [workspacePaths] - workspace roots to scan.
   * @returns {Promise<object[]>} the rebuilt entries.
   */
  async function rebuild(workspacePaths = []) {
    const entries = await scanEntries(workspacePaths)
    await saveIndex({ version: INDEX_VERSION, entries })
    return entries
  }

  /**
   * Load (and, when missing, reconstruct) the index once at startup.
   *
   * The reconstruction scans the project report directories, so a deleted
   * index does not orphan reports that still have their `meta.json`.
   *
   * @param {string[]} [workspacePaths] - workspace roots to scan.
   * @returns {Promise<number>} the number of entries.
   */
  async function warm(workspacePaths = []) {
    cache = null
    indexWasPresent = false
    const index = await loadIndex(workspacePaths)
    if (!indexWasPresent) await saveIndex(index)
    return index.entries.length
  }

  // Mutations are serialized: two reports finishing together must not read the
  // same index and overwrite each other's entry.
  let tail = Promise.resolve()
  const serialize = (task) => {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    save: (input) => serialize(() => save(input)),
    list,
    read,
    remove: (id) => serialize(() => remove(id)),
    rebuild: (workspacePaths = []) => serialize(() => rebuild(workspacePaths)),
    warm: (workspacePaths = []) => serialize(() => warm(workspacePaths)),
    paths: { globalRoot, indexPath },
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, lstat, readdir, cp, statfs } from 'node:fs/promises'
import path from 'node:path'

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
  try { await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
}
export function inside(root, candidate) {
  const target = path.resolve(candidate), relative = path.relative(path.resolve(root), target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('更新路径越界')
  return target
}
export async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function inventory(root) {
  const files = []
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, filename = path.join(directory, entry.name)
      const info = await lstat(filename)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('升级数据包含不支持的链接或特殊文件')
      if (info.isDirectory()) { files.push({ path: relative, directory: true }); await walk(filename, relative) }
      else files.push({ path: relative, bytes: info.size, sha256: await hashFile(filename) })
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
export async function checkSpace(directory, bytes) {
  const info = await statfs(directory)
  if (Number(info.bavail) * Number(info.bsize) < bytes + 128 * 1024 * 1024) throw new Error('磁盘空间不足，无法保存新版本和完整恢复点')
}
export async function snapshot(roots, destination) {
  const manifest = []
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index], files = await inventory(root), backup = path.join(destination, String(index))
    await checkSpace(destination, files.reduce((n, file) => n + (file.bytes || 0), 0) * 2)
    await cp(root, backup, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    const copied = await inventory(backup)
    if (JSON.stringify(files) !== JSON.stringify(copied)) throw new Error('完整备份校验失败')
    manifest.push({ root, index, files })
  }
  await writeJson(path.join(destination, 'snapshot.json'), manifest)
  return manifest
}
export async function restoreSnapshot(roots, destination, failureDirectory) {
  const manifest = await readJson(path.join(destination, 'snapshot.json'))
  if (!manifest || manifest.length !== roots.length) throw new Error('完整恢复点不存在')
  // Validate every backup before touching any original data. Never overlay WAL/new files.
  for (const [index, item] of manifest.entries()) {
    if (item.root !== roots[index] || item.index !== index || JSON.stringify(await inventory(path.join(destination, String(index)))) !== JSON.stringify(item.files)) throw new Error('恢复点清单不匹配')
  }
  await mkdir(failureDirectory, { recursive: true, mode: 0o700 })
  for (const [index, item] of manifest.entries()) {
    const root = roots[index], failed = path.join(failureDirectory, String(index))
    if (!await readJson(path.join(failureDirectory, `${index}.saved.json`))) {
      await rm(failed, { recursive: true, force: true })
      await cp(root, failed, { recursive: true, preserveTimestamps: true })
      await writeJson(path.join(failureDirectory, `${index}.saved.json`), { saved: true })
    }
    for (const entry of await readdir(root)) await rm(inside(root, path.join(root, entry)), { recursive: true, force: true, maxRetries: 5 })
    await cp(path.join(destination, String(index)), root, { recursive: true, preserveTimestamps: true })
    if (JSON.stringify(await inventory(root)) !== JSON.stringify(item.files)) throw new Error('恢复后的数据校验失败')
  }
}

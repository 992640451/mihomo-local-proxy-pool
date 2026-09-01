import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseEnv, resolveRuntimePaths } from '../server/runtime/paths.mjs'

test('parses runtime environment files without accepting invalid keys', () => {
  assert.deepEqual(parseEnv('# comment\nPORT=4173\nINVALID-KEY=value\nEMPTY=\nTOKEN=a=b\n'), {
    PORT: '4173',
    EMPTY: '',
    TOKEN: 'a=b',
  })
})

test('resolves a packaged portable layout with data outside the application code', async () => {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'ppm-runtime-')))
  const previousPortable = process.env.PPM_PORTABLE
  try {
    await mkdir(path.join(root, 'app', 'server'), { recursive: true })
    await writeFile(path.join(root, 'app', 'server', 'index.mjs'), '')
    process.env.PPM_PORTABLE = '1'
    const paths = resolveRuntimePaths({ root })
    assert.equal(paths.packaged, true)
    assert.equal(paths.appRoot, path.join(root, 'app'))
    assert.equal(paths.dataDir, path.join(root, 'data'))
    assert.equal(paths.coreExecutable, path.join(root, 'core', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'))
  } finally {
    if (previousPortable === undefined) delete process.env.PPM_PORTABLE
    else process.env.PPM_PORTABLE = previousPortable
    await rm(root, { recursive: true, force: true })
  }
})

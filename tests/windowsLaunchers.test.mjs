import assert from 'node:assert/strict'
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { copyPortableLaunchers, WINDOWS_LAUNCHERS } from '../scripts/portable-launchers.mjs'
import { runWindowsLauncher } from '../scripts/smoke-windows-launchers.mjs'
import { smokeEnvironment } from '../scripts/smoke-portable.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const commands = ['start --background', 'open', 'stop']

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ppm-launchers-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return temporary
}

test('Windows launchers anchor paths, preserve exit codes and keep result windows open', async () => {
  for (const [index, file] of WINDOWS_LAUNCHERS.entries()) {
    const content = await readFile(path.join(root, file), 'utf8')
    assert.ok(content.includes(`call "%~dp0bin\\ppm.cmd" ${commands[index]} %*`))
    assert.match(content, /setlocal DisableDelayedExpansion/)
    assert.match(content, /chcp 65001 >nul/)
    assert.match(content, /set "PPM_RESULT=%ERRORLEVEL%"/)
    assert.match(content, /pause >nul/)
    assert.match(content, /exit \/b %PPM_RESULT%/)
  }
})

test('portable packaging includes beginner launchers only on Windows', async t => {
  const temporary = await fixture(t)
  for (const platform of ['win32', 'linux', 'darwin']) {
    const destination = path.join(temporary, platform)
    await mkdir(destination)
    await copyPortableLaunchers(root, destination, platform)
    const expected = (platform === 'win32' ? ['bin/ppm.cmd', ...WINDOWS_LAUNCHERS] : ['ppm']).sort()
    const copied = (await readdir(destination, { recursive: true })).map(file => file.replaceAll('\\', '/')).sort()
    assert.deepEqual(copied, [...expected, ...(platform === 'win32' ? ['bin'] : [])].sort())
    for (const file of expected) assert.deepEqual(await readFile(path.join(destination, file)), await readFile(path.join(root, file)))
  }
})

test('real cmd launchers accept Chinese/special paths, forward arguments and preserve failures', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fixture(t)
  const folder = path.join(temporary, '中文 & portable (test)!')
  await mkdir(path.join(folder, 'bin'), { recursive: true })
  for (const [index, file] of WINDOWS_LAUNCHERS.entries()) {
    await cp(path.join(root, file), path.join(folder, file))
    for (const code of [0, 7]) {
      // Synthetic CLI only; no real configuration, browser or service is touched.
      await writeFile(path.join(folder, 'bin', 'ppm.cmd'), `@echo off\r\necho ARGS:%*\r\nexit /b ${code}\r\n`)
      const result = await runWindowsLauncher(path.join(folder, file), ['--no-open'], { cwd: temporary })
      assert.equal(result.code, code, result.output)
      assert.ok(result.output.includes(`ARGS:${commands[index]} --no-open`), result.output)
      assert.ok(result.output.includes('按任意键关闭此窗口'), 'Chinese prompt should survive cmd encoding')
      if (code !== 0) assert.match(result.output, /failed|Could not open/)
    }
  }
})

test('internal Windows CLI keeps the installation root and supports source and bundled runtimes', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fixture(t)
  for (const packaged of [false, true]) {
    const folder = path.join(temporary, `中文 & cli (${packaged})!`)
    const scripts = path.join(folder, ...(packaged ? ['app', 'scripts'] : ['scripts']))
    await mkdir(path.join(folder, 'bin'), { recursive: true })
    await mkdir(scripts, { recursive: true })
    await cp(path.join(root, 'bin', 'ppm.cmd'), path.join(folder, 'bin', 'ppm.cmd'))
    await writeFile(path.join(scripts, 'launcher.mjs'), 'console.log(JSON.stringify({ root: process.env.PPM_ROOT, portable: process.env.PPM_PORTABLE, args: process.argv.slice(2) })); process.exitCode = 7\n')
    const env = smokeEnvironment(folder, 4173, 19090)
    // Force the internal script to derive its root rather than inherit our fixture.
    delete env.PPM_ROOT
    if (packaged) {
      await mkdir(path.join(folder, 'runtime'))
      const runtime = path.join(folder, 'runtime', 'node.exe')
      await link(process.execPath, runtime).catch(() => cp(process.execPath, runtime))
    } else {
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
      env[pathKey] = `${path.dirname(process.execPath)};${env[pathKey] || ''}`
    }
    const result = await runWindowsLauncher(path.join(folder, 'bin', 'ppm.cmd'), ['--fixture', '"argument with spaces"'], { env, cwd: temporary })
    assert.equal(result.code, 7, result.output)
    const actual = JSON.parse(result.output.trim())
    assert.equal(path.resolve(actual.root), folder, 'PPM_ROOT must be the parent of bin, not bin or cwd')
    assert.equal(actual.portable, '1')
    assert.deepEqual(actual.args, ['--fixture', 'argument with spaces'])
  }
})

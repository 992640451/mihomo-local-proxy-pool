// Isolated end-to-end fixture: real portable processes, local signed release transport.
// Never used by production builds. The release transport override lives only in this fixture.
import { generateKeyPairSync, scryptSync, sign } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateConfiguration } from '../../scripts/init.mjs'
import { smokeEnvironment } from '../../scripts/smoke-portable.mjs'
import { readJson, writeJson, hashFile } from '../../server/updates/files.mjs'
import { run } from '../../server/updates/process.mjs'
import { UPDATE_REPOSITORY, platformTarget } from '../../server/updates/manifest.mjs'

const packageRoot = path.resolve(process.argv[2])
const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve('.artifacts', `update-demo-${Date.now()}`)
if (path.dirname(root) !== path.resolve('.artifacts') || !path.basename(root).startsWith('update-demo-')) throw new Error('Fixture must be an isolated .artifacts/update-demo directory')
const installed = path.join(root, '已有安装 中文'), releaseRoot = path.join(root, 'release'), next = path.join(releaseRoot, 'proxy-port-manager-v1.3.0')
await mkdir(root, { recursive: true })
if (!existsSync(path.join(installed, 'app', 'build-info.json'))) await cp(packageRoot, installed, { recursive: true })
const keyPair = generateKeyPairSync('ed25519')
const keys = { fixture: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) }
await writeJson(path.join(installed, 'app', 'release', 'update-public-keys.json'), keys)
const originalInfo = await readJson(path.join(installed, 'app', 'build-info.json'))
originalInfo.version = '1.2.0'; originalInfo.revision = 'a'.repeat(40)
await writeJson(path.join(installed, 'app', 'build-info.json'), originalInfo)
const baselinePackage = await readJson(path.join(installed, 'app', 'package.json'))
await writeJson(path.join(installed, 'app', 'package.json'), { ...baselinePackage, version: '1.2.0' })
if (!existsSync(path.join(next, 'app', 'build-info.json'))) await cp(installed, next, { recursive: true })
await writeJson(path.join(next, 'app', 'release', 'update-public-keys.json'), keys)
const targetPackage = await readJson(path.join(next, 'app', 'package.json'))
targetPackage.version = '1.3.0'
await writeJson(path.join(next, 'app', 'package.json'), targetPackage)
await writeJson(path.join(next, 'app', 'build-info.json'), { ...originalInfo, version: '1.3.0', revision: 'b'.repeat(40) })
const archive = path.join(root, `proxy-port-manager-v1.3.0-${platformTarget()}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`)
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
await run(tar, [process.platform === 'win32' ? '-acf' : '-czf', archive, '-C', releaseRoot, path.basename(next)], { timeout: 15 * 60 * 1000 })
const manifest = { schemaVersion: 1, updaterProtocol: 1, repository: UPDATE_REPOSITORY, version: '1.3.0', minVersion: '1.2.0', maxVersion: '1.2.0', revision: 'b'.repeat(40), portable: { [platformTarget()]: { url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v1.3.0/${path.basename(archive)}`, bytes: (await stat(archive)).size, sha256: await hashFile(archive) } } }
const bytes = Buffer.from(JSON.stringify(manifest)), envelope = { algorithm: 'ed25519', keyId: 'fixture', payload: bytes.toString('base64'), signature: sign(null, bytes, keyPair.privateKey).toString('base64') }
const transport = path.join(root, 'fixture.json')
await writeJson(transport, { archive, envelope, repository: UPDATE_REPOSITORY })
const preload = path.join(root, 'transport.mjs')
await writeFile(preload, `import { readFileSync, createReadStream } from 'node:fs';\nimport { Readable } from 'node:stream';\nconst fixture = JSON.parse(readFileSync(${JSON.stringify(transport)}, 'utf8'));\nconst original = globalThis.fetch;\nglobalThis.fetch = async (input, options) => { const url = String(input?.url || input); if (url === 'https://api.github.com/repos/' + fixture.repository + '/releases/latest') return new Response(JSON.stringify({ tag_name:'v1.3.0', published_at:'2026-09-03T00:00:00Z', body:'隔离升级测试：新版提示、完整备份、自动重启和数据保留。', assets:[{name:'update-manifest.json'}] })); if (url.startsWith('https://github.com/' + fixture.repository + '/releases/download/v1.3.0/')) return url.endsWith('update-manifest.json') ? new Response(JSON.stringify(fixture.envelope)) : new Response(Readable.toWeb(createReadStream(fixture.archive))); return original(input, options); };\n`)
await mkdir(path.join(installed, 'data'), { recursive: true })
const config = generateConfiguration().content.replace(/^AUTH_USERNAME=.*$/m, 'AUTH_USERNAME=update-demo').replace(/^AUTH_PASSWORD_SALT=.*$/m, 'AUTH_PASSWORD_SALT=update-fixture-salt').replace(/^AUTH_PASSWORD_SCRYPT=.*$/m, `AUTH_PASSWORD_SCRYPT=${scryptSync('update-demo-password', 'update-fixture-salt', 64).toString('hex')}`)
await writeFile(path.join(installed, 'data', 'config.env'), config)
const env = { ...smokeEnvironment(installed, 43021, 43022), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }
const node = path.join(installed, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
await run(node, [path.join(installed, 'app', 'scripts', 'launcher.mjs'), 'start', '--background', '--no-open'], { env, timeout: 60000 })
await writeJson(path.resolve('.artifacts', 'update-demo-current.json'), { root, installed, env, node, url: 'http://127.0.0.1:43021' })
console.log(`Isolated update demo ready: http://127.0.0.1:43021 (update-demo / update-demo-password)`)
console.log(`Fixture: ${root}`)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argument, readReleaseMetadata } from './release-utils.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const root = path.resolve(argument(process.argv, '--root', scriptRoot))
  const tag = argument(process.argv, '--tag', process.env.GITHUB_REF_NAME)
  const output = argument(process.argv, '--output')
  if (!output) throw new Error('必须通过 --output 指定发行说明文件')
  const metadata = await readReleaseMetadata(root, tag)
  const manifest = JSON.parse(await readFile(path.join(root, 'release', 'core-manifest.json'), 'utf8'))
  const content = `${metadata.notes}

## 下载

- Windows x64：\`proxy-port-manager-${metadata.tag}-windows-x64.zip\`
- Linux x64：\`proxy-port-manager-${metadata.tag}-linux-x64.tar.gz\`
- Linux ARM64：\`proxy-port-manager-${metadata.tag}-linux-arm64.tar.gz\`
- macOS Intel：\`proxy-port-manager-${metadata.tag}-macos-x64.tar.gz\`
- macOS Apple Silicon：\`proxy-port-manager-${metadata.tag}-macos-arm64.tar.gz\`

便携包内置 Node.js 和 Mihomo ${manifest.version}。升级时请保留原解压目录中的 \`data\` 文件夹。

## 完整性校验

下载 \`SHA256SUMS.txt\` 后，使用 \`sha256sum -c SHA256SUMS.txt\`；Windows 用户也可以使用 \`Get-FileHash -Algorithm SHA256\`。GitHub CLI 用户可执行 \`gh attestation verify <文件> --repo ${process.env.GITHUB_REPOSITORY || '992640451/mihomo-local-proxy-pool'}\` 验证构建来源。
`
  const outputFile = path.resolve(output)
  await mkdir(path.dirname(outputFile), { recursive: true })
  await writeFile(outputFile, content, 'utf8')
  console.log(`发行说明已生成：${outputFile}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

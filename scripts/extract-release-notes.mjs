import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argument, readReleaseMetadata, portableMatrix } from './release-utils.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const root = path.resolve(argument(process.argv, '--root', scriptRoot))
  const tag = argument(process.argv, '--tag', process.env.GITHUB_REF_NAME)
  const output = argument(process.argv, '--output')
  if (!output) throw new Error('必须通过 --output 指定发行说明文件')
  const metadata = await readReleaseMetadata(root, tag)
  const manifest = JSON.parse(await readFile(path.join(root, 'release', 'core-manifest.json'), 'utf8'))
  const downloads = portableMatrix(manifest).include.map(({ platform, arch }) => `- ${platform} ${arch}：\`proxy-port-manager-${metadata.tag}-${platform}-${arch}.${platform === 'windows' ? 'zip' : 'tar.gz'}\``).join('\n')
  const content = `${metadata.notes}

## 下载

${downloads}

便携包内置 Node.js 和 Mihomo ${manifest.version}。升级时请保留原解压目录中的 \`data\` 文件夹。

## 完整性校验

下载 \`SHA256SUMS.txt\` 后，使用 \`sha256sum -c SHA256SUMS.txt\`；Windows 用户也可以使用 \`Get-FileHash -Algorithm SHA256\`。GitHub CLI 用户可执行 \`gh attestation verify <文件> --repo ${process.env.GITHUB_REPOSITORY || '992640451/mihomo-local-proxy-pool'}\` 验证构建来源。

每个便携包附带 \`.cdx.json\`（CycloneDX SBOM）和 \`.build.json\`（版本、源码提交、构建时间、核心校验信息），均包含在 SHA256SUMS 中。SBOM 覆盖 npm 构建依赖图（包括前端和构建工具）与内置 Node.js/Mihomo 二进制，不代表完整原生传递依赖清单。

## 容器镜像

${process.env.RELEASE_IMAGE_DIGEST ? `Linux amd64/arm64：\`${process.env.RELEASE_IMAGE}:${metadata.tag}\`。建议固定不可变摘要：\`${process.env.RELEASE_IMAGE}@${process.env.RELEASE_IMAGE_DIGEST}\`。镜像附带 BuildKit SBOM 和来源证明。` : '本次 Draft 验证没有推送 GHCR 镜像；正式发布后才会提供镜像摘要。'}
`
  const outputFile = path.resolve(output)
  await mkdir(path.dirname(outputFile), { recursive: true })
  await writeFile(outputFile, content, 'utf8')
  console.log(`发行说明已生成：${outputFile}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

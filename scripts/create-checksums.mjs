import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { argument } from './release-utils.mjs'

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(filename).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
  })
}

async function main() {
  const directory = path.resolve(argument(process.argv, '--directory', 'release-assets'))
  const output = path.resolve(argument(process.argv, '--output', path.join(directory, 'SHA256SUMS.txt')))
  const expected = Number(argument(process.argv, '--expected', '5'))
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && (/\.zip$/.test(entry.name) || /\.tar\.gz$/.test(entry.name)))
    .map(entry => entry.name)
    .sort()
  if (files.length !== expected) throw new Error(`发布制品数量错误：期望 ${expected}，实际 ${files.length}`)
  const lines = []
  for (const file of files) lines.push(`${await sha256(path.join(directory, file))}  ${file}`)
  await writeFile(output, `${lines.join('\n')}\n`, 'utf8')
  console.log(`已为 ${files.length} 个发布制品生成 SHA256 校验文件`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

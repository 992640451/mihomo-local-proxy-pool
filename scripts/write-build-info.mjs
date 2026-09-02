import path from 'node:path'
import { buildMetadata, writeJson } from './build-metadata.mjs'
import { argument } from './release-utils.mjs'

const root = path.resolve(argument(process.argv, '--root', '.'))
await writeJson(path.join(root, 'build-info.json'), await buildMetadata(root, {
  target: argument(process.argv, '--target', `${process.platform}-${process.arch}`),
}))

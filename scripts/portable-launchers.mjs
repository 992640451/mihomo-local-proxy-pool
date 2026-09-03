import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

export const WINDOWS_LAUNCHERS = ['启动管理器.cmd', '打开管理页面.cmd', '停止管理器.cmd']

export async function copyPortableLaunchers(sourceRoot, destinationRoot, platform = process.platform) {
  const files = platform === 'win32' ? ['bin/ppm.cmd', ...WINDOWS_LAUNCHERS] : ['ppm']
  for (const file of files) {
    const destination = path.join(destinationRoot, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(sourceRoot, file), destination)
  }
}

import path from 'node:path'

// Git Bash can put GNU tar ahead of Windows bsdtar on PATH. GNU tar treats
// drive letters as remote hosts and cannot create the ZIP archives we ship.
export function tarCommand(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar'
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('无法定位 Windows 系统归档工具')
  return path.win32.join(systemRoot, 'System32', 'tar.exe')
}

import path from 'node:path'

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|content|yaml|raw)/i
const URL_KEY = /(?:^|[-_])url$/i
const URL_PATTERN = /https?:\/\/[^\s"'<>，。；）)]+/gi

function replaceAllLiteral(value, search, replacement) {
  if (!search) return value
  return value.split(search).join(replacement)
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value))
    if (!['http:', 'https:'].includes(url.protocol)) return '<redacted-url>'
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '***')
    if (url.hash) url.hash = '#***'
    const parts = url.pathname.split('/')
    const last = parts.findLastIndex(Boolean)
    if (last >= 0) parts[last] = '***'
    url.pathname = parts.join('/')
    return url.toString()
  } catch {
    return '<redacted-url>'
  }
}

export function redactText(value) {
  let text = String(value ?? '')
  text = text.replace(URL_PATTERN, match => redactUrl(match))
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
  text = text.replace(/\b(password|passwd|secret|token|api[-_]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=***')
  const homePaths = [process.env.USERPROFILE, process.env.HOME]
    .filter(Boolean)
    .map(value => path.resolve(value))
    .sort((a, b) => b.length - a.length)
  for (const home of homePaths) {
    text = replaceAllLiteral(text, home, '<home>')
    text = replaceAllLiteral(text, home.replaceAll('\\', '/'), '<home>')
  }
  return text
}

export function redactSensitive(value, { depth = 0 } = {}) {
  if (depth > 8) return '<redacted-depth-limit>'
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, { depth: depth + 1 }))
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) }
  if (typeof value !== 'object') return String(value)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (URL_KEY.test(key)) return [key, item ? redactUrl(item) : item]
    if (SECRET_KEY.test(key)) return [key, item ? '<redacted>' : item]
    return [key, redactSensitive(item, { depth: depth + 1 })]
  }))
}

export function parseTokens() {
  try {
    const tokensJson = process.env.LINDELA_LITE_TOKENS
    if (!tokensJson) {
      const apiKey = process.env.LINDELA_LITE_API_KEY
      if (!apiKey) return []
      return [{ token: apiKey, scopes: ['*'] }]
    }
    const tokens = JSON.parse(tokensJson)
    if (!Array.isArray(tokens)) return []
    return tokens.map(t => ({ token: t.token, scopes: t.scopes || [] }))
  } catch {
    return []
  }
}

export function authenticate(req) {
  const tokens = parseTokens()
  if (!tokens.length) return null

  let token = null
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else {
    token = req.headers['x-api-key']
  }

  if (!token) return null

  const found = tokens.find(t => t.token === token)
  if (!found) return null

  return {
    token,
    scopes: found.scopes || [],
    subject: `token_${token.slice(0, 8)}`,
  }
}

export function requireScope(auth, scope) {
  if (!auth) {
    const error = new Error('Unauthorized')
    error.statusCode = 401
    throw error
  }

  if (auth.scopes.includes('*')) return

  if (!auth.scopes.includes(scope)) {
    const error = new Error('Insufficient permissions')
    error.statusCode = 403
    throw error
  }
}

export function scopeForRoute(method, pathname) {
  if (method === 'GET') return 'read:hazards'

  if (pathname.startsWith('/api/v1/ingest/') || pathname.startsWith('/api/v1/report-schedules/')) {
    return 'admin:schedules'
  }

  if (pathname.startsWith('/api/v1/alert-rules') || pathname.startsWith('/api/v1/alert-events')) {
    return 'admin:alerts'
  }

  if (pathname.startsWith('/api/v1/reports') || pathname.startsWith('/api/v1/report-templates')) {
    return 'write:reports'
  }

  if (pathname.includes('/incidents') || pathname.includes('/interventions') || pathname.includes('/intervention-tasks') || pathname.includes('/field-reports') || pathname.includes('/response-resources')) {
    return 'write:incidents'
  }

  return 'read:hazards'
}

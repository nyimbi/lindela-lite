export function defineConnector(input) {
  const errors = validateConnectorInput(input)
  if (errors.length) {
    throw Object.assign(new Error(`Invalid connector definition: ${errors.join(', ')}`), { errors })
  }

  const spec = {
    id: input.id,
    description: input.description,
    schema: input.schema || {},
    defaults: input.defaults || {},
    ingest: input.ingest,
  }

  return Object.freeze(spec)
}

export function validateConnector(spec) {
  if (!spec) return ['Connector spec is required']

  const errors = []

  if (!spec.id || typeof spec.id !== 'string') {
    errors.push('id must be a non-empty string')
  }

  if (!spec.description || typeof spec.description !== 'string') {
    errors.push('description must be a non-empty string')
  }

  if (typeof spec.schema !== 'object' || spec.schema === null) {
    errors.push('schema must be an object')
  }

  if (typeof spec.defaults !== 'object' || spec.defaults === null) {
    errors.push('defaults must be an object')
  }

  if (typeof spec.ingest !== 'function') {
    errors.push('ingest must be an async function')
  }

  return errors
}

function validateConnectorInput(input) {
  if (!input || typeof input !== 'object') {
    return ['Input must be an object']
  }

  const errors = []

  if (!input.id || typeof input.id !== 'string') {
    errors.push('id is required and must be a string')
  }

  if (!input.description || typeof input.description !== 'string') {
    errors.push('description is required and must be a string')
  }

  if (input.schema !== undefined && (typeof input.schema !== 'object' || input.schema === null)) {
    errors.push('schema must be an object')
  }

  if (input.defaults !== undefined && (typeof input.defaults !== 'object' || input.defaults === null)) {
    errors.push('defaults must be an object')
  }

  if (input.ingest !== undefined && typeof input.ingest !== 'function') {
    errors.push('ingest must be a function')
  }

  return errors
}

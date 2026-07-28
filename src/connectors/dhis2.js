import { defineConnector } from './spec.js'

const SCAFFOLD_MSG = 'DHIS2 base_url not configured; scaffold ingestion is a no-op until wired to a real instance.'

async function dhis2Ingest(request = {}) {
  // Default off: only runs when LINDELA_LITE_DHIS2_ENABLED is explicitly 'on'
  const enabled = process.env.LINDELA_LITE_DHIS2_ENABLED === 'on'
  if (!enabled || !request.base_url) {
    return {
      climate_observations: [],
      errors: [SCAFFOLD_MSG],
    }
  }

  // Scaffold: real bidirectional sync would fetch from DHIS2 data elements here.
  // See docs/dhis2-integration.md for wiring instructions.
  return {
    climate_observations: [],
    errors: [SCAFFOLD_MSG],
  }
}

export const dhis2Connector = defineConnector({
  id: 'dhis2',
  description: 'DHIS2 bidirectional sync scaffold (configure base_url and api_token to activate)',
  schema: {
    base_url: 'string — DHIS2 instance root URL',
    api_token: 'string — personal access token or basic auth base64',
    org_units: 'array of string — DHIS2 org unit UIDs',
    data_elements: 'array of string — data element UIDs to pull',
    period: 'string — DHIS2 period e.g. 2026Q3',
  },
  defaults: {
    org_units: [],
    data_elements: [],
    period: null,
  },
  ingest: dhis2Ingest,
})

export const spec = dhis2Connector

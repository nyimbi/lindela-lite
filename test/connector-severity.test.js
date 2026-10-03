import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { gdacsConnector } from '../src/connectors/gdacs.js'
import { glofasConnector } from '../src/connectors/glofas.js'
import { severityWeight } from '../src/schema.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Serve a literal XML body to the connector's real parser. */
function serveXml(xml) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/xml']]),
    text: async () => xml,
    json: async () => ({}),
  })
}

function gdacsItem({ title, description = '', level, score, guid }) {
  return `<item><title>${title}</title>`
    + `<link>https://www.gdacs.org/report.aspx?id=${guid || 'X'}</link>`
    + `<description><![CDATA[${description}]]></description>`
    + '<pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate>'
    + `<guid>${guid || 'X'}</guid>`
    + '<gdacs:eventtype>FL</gdacs:eventtype>'
    + (level === undefined ? '' : `<gdacs:alertlevel>${level}</gdacs:alertlevel>`)
    + (score === undefined ? '' : `<gdacs:alertscore>${score}</gdacs:alertscore>`)
    + '<gdacs:country>South Sudan</gdacs:country></item>'
}

async function ingestGdacs(items) {
  serveXml(`<rss><channel>${items.join('')}</channel></rss>`)
  const result = await gdacsConnector.ingest({
    gdacs_feeds: ['https://fixture.test/gdacs.xml'],
    retries: 0,
  })
  assert.equal(result.errors.length, 0, result.errors.join('; '))
  return result.hazard_events
}

async function ingestGlofas(items) {
  serveXml(`<rss><channel>${items.join('')}</channel></rss>`)
  const result = await glofasConnector.ingest({
    glofas_feeds: ['https://fixture.test/glofas.xml'],
    retries: 0,
  })
  assert.equal(result.errors.length, 0, result.errors.join('; '))
  return result.hazard_events
}

describe('GDACS severity comes from the alert level the feed publishes', () => {
  // "predicTed" contains "red", "Red Sea" is a place, "reduced" is an ordinary
  // word. Substring matching turned every one of them into a red alert, and
  // risk scoring reads severity — so a green South Sudan flood was stored as
  // critical next to alert_level: "green".
  it('is not fooled by "predicted" in a green alert description', async () => {
    const [event] = await ingestGdacs([gdacsItem({
      title: 'Green flood alert in South Sudan',
      description: 'Flood risk is predicted to continue over the coming week',
      level: 'Green',
      score: '0',
      guid: 'FL-predicted',
    })])
    assert.equal(event.severity, 'low')
    assert.equal(event.metadata.alert_level, 'green')
  })

  it('is not fooled by the words "Red Sea" or "reduced" in a green alert', async () => {
    const [sea] = await ingestGdacs([gdacsItem({
      title: 'Green flood alert in a Red Sea coastal zone',
      description: 'Water levels reduced slightly overnight',
      level: 'Green',
      score: '0',
      guid: 'FL-redsea',
    })])
    assert.equal(sea.severity, 'low')
    assert.equal(sea.metadata.alert_level, 'green')
  })

  it('does not read prose colour words when the feed publishes no alert level', async () => {
    const [event] = await ingestGdacs([gdacsItem({
      title: 'Orange-looking flood alert in South Sudan',
      description: 'Rivers in the Red Sea basin are high and rising',
      guid: 'FL-nolevel',
    })])
    assert.equal(event.severity, null,
      'an alert with no published level is ungraded, not a colour sniffed from prose')
    assert.equal(event.metadata.alert_level, null)
  })

  it('reads the published level for orange and red, with no prose to lean on', async () => {
    const [orange, red] = await ingestGdacs([
      gdacsItem({ title: 'Flood alert in South Sudan', level: 'Orange', score: '1', guid: 'FL-orange' }),
      gdacsItem({ title: 'Flood alert in South Sudan', level: 'Red', score: '2', guid: 'FL-red' }),
    ])
    assert.equal(orange.severity, 'high')
    assert.equal(red.severity, 'critical')
  })

  it('leaves severity null for a level the feed vocabulary does not define', async () => {
    const [event] = await ingestGdacs([gdacsItem({
      title: 'Flood alert in South Sudan', level: 'Purple', guid: 'FL-purple',
    })])
    assert.equal(event.severity, null, 'an undefined level is not silently rounded to a real one')
  })

  it('keeps a green alert score of 0 rather than losing it to a falsy fallback', async () => {
    const [green, missing] = await ingestGdacs([
      gdacsItem({ title: 'Flood alert in South Sudan', level: 'Green', score: '0', guid: 'FL-zero' }),
      gdacsItem({ title: 'Flood alert in South Sudan', level: 'Orange', guid: 'FL-nosc' }),
    ])
    assert.equal(green.metadata.alert_score, 0, 'level 0 is a score, not an absent score')
    assert.equal(missing.metadata.alert_score, null, 'an absent score stays absent')
  })
})

describe('GloFAS publishes no severity, so the connector publishes none', () => {
  it('emits no severity for an item with no severity signal in its text', async () => {
    const [event] = await ingestGlofas([`<item><title>Flood forecast update</title>
      <link>https://global-flood.example/1</link>
      <description>Forecast threshold exceeded.</description>
      <pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate></item>`])
    assert.equal(event.severity, null,
      'the feed carries no severity; a default of "medium" asserts one it did not measure')
  })

  it('does not promote an item to high because the word "high" appears in prose', async () => {
    const [event] = await ingestGlofas([`<item><title>Flood forecast for a high latitude basin</title>
      <link>https://global-flood.example/2</link>
      <description>Red alert chatter about a river in the north.</description>
      <pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate></item>`])
    assert.equal(event.severity, null)
  })

  it('carries a null severity into risk scoring as less than a real measurement', async () => {
    const [event] = await ingestGlofas([`<item><title>Flood forecast update</title>
      <link>https://global-flood.example/3</link>
      <description>Forecast threshold exceeded.</description>
      <pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate></item>`])
    // analytics.js:76 sums severityWeight(event.severity) * 30 over every hazard
    // in range. A null severity must contribute less than a medium one, which
    // is the whole difference between "unmeasured" and "measured as moderate".
    assert.ok(severityWeight(event.severity) < severityWeight('medium'),
      'an unmeasured GloFAS forecast must not score as a medium-severity hazard')
    assert.ok(severityWeight(event.severity) < severityWeight('high'))
  })
})

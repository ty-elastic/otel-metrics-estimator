import { useState, useEffect, useCallback } from 'react'
import ReceiverRow from './ReceiverRow'
import ResourceAttrsPanel from './ResourceAttrsPanel'
import EstimateResults from './EstimateResults'
import './App.css'

function initConfig(receivers) {
  const cfg = {}
  for (const recv of receivers) {
    const scrapers = {}
    for (const s of (recv.scrapers || [])) {
      const cardinality = {}
      for (const a of (s.attributes || [])) {
        cardinality[a.name] = a.default_cardinality ?? ((a.values && a.values.length > 0) ? a.values.length : 1)
      }
      scrapers[s.name] = {
        enabled:                       s.default_enabled ?? true,
        pollingS:                     s.default_polling_interval_s ?? 60,
        cardinality,
        resourceAttributesCardinality: s.resource_attributes?.default_cardinality ?? 1,
      }
    }
    cfg[recv.name] = {
      enabled:   false,
      expanded:  false,
      instances: 1,
      scrapers,
    }
  }
  return cfg
}

function initResourceAttrsConfig(processors) {
  const cfg = {}
  for (const proc of (processors || [])) {
    const attributes = {}
    for (const attr of (proc.attributes || [])) {
      attributes[attr.name] = attr.default_enabled ?? true
    }
    cfg[proc.processor] = { enabled: proc.default_enabled ?? true, expanded: false, attributes }
  }
  return cfg
}

function buildEstimateBody(receivers, config, resourceProcs, resourceCfg) {
  // resource_attributes: flat include-list of all enabled attr names across enabled processors
  const resource_attributes = []
  for (const proc of resourceProcs) {
    const pcfg = resourceCfg[proc.processor]
    if (!pcfg?.enabled) continue
    for (const [name, on] of Object.entries(pcfg.attributes || {})) {
      if (on) resource_attributes.push(name)
    }
  }

  // receivers: only enabled ones
  const recvList = []
  for (const recv of receivers) {
    const rcfg = config[recv.name]
    if (!rcfg?.enabled) continue

    const scrapers = []
    for (const scraper of (recv.scrapers || [])) {
      const scfg = rcfg.scrapers?.[scraper.name]
      if (!scfg?.enabled) continue
      scrapers.push({
        name:             scraper.name,
        polling_interval: scfg.pollingS,
        attributes:       Object.fromEntries(
          Object.entries(scfg.cardinality).map(([k, v]) => [k, { cardinality: v }])
        ),
        ...((scraper.resource_attributes?.attributes || []).length > 0 && {
          resource_attributes: { cardinality: scfg.resourceAttributesCardinality },
        }),
      })
    }

    recvList.push({
      name:      recv.name,
      instances: rcfg.instances,
      scrapers,
    })
  }

  return { resource_attributes, receivers: recvList }
}

export default function App() {
  const [receivers, setReceivers]         = useState([])
  const [config, setConfig]               = useState({})
  const [resourceProcs, setResourceProcs] = useState([])
  const [resourceCfg, setResourceCfg]     = useState({})
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState(null)

  // Estimation
  const [estimating, setEstimating]       = useState(false)
  const [estimateError, setEstimateError] = useState(null)
  const [results, setResults]             = useState(null)   // null = config screen

  useEffect(() => {
    fetch('/receivers')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(data => {
        const sorted = [...(data.receivers || data)].sort((a, b) => a.name.localeCompare(b.name))
        setReceivers(sorted)
        setConfig(initConfig(sorted))
        const procs = data.resource_attributes || []
        setResourceProcs(procs)
        setResourceCfg(initResourceAttrsConfig(procs))
        setLoading(false)
      })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [])

  const updateReceiver = useCallback((name, patch) =>
    setConfig(prev => ({ ...prev, [name]: { ...prev[name], ...patch } })), [])

  const updateScraper = useCallback((recvName, scraperName, patch) =>
    setConfig(prev => ({
      ...prev,
      [recvName]: {
        ...prev[recvName],
        scrapers: {
          ...prev[recvName].scrapers,
          [scraperName]: { ...prev[recvName].scrapers[scraperName], ...patch },
        },
      },
    })), [])

  const updateCardinality = useCallback((recvName, scraperName, attrName, count) =>
    setConfig(prev => ({
      ...prev,
      [recvName]: {
        ...prev[recvName],
        scrapers: {
          ...prev[recvName].scrapers,
          [scraperName]: {
            ...prev[recvName].scrapers[scraperName],
            cardinality: {
              ...prev[recvName].scrapers[scraperName].cardinality,
              [attrName]: count,
            },
          },
        },
      },
    })), [])

  const toggleProcessor = useCallback((procKey, field, value) =>
    setResourceCfg(prev => ({
      ...prev,
      [procKey]: { ...prev[procKey], [field]: value },
    })), [])

  const toggleAttr = useCallback((procKey, attrName, value) =>
    setResourceCfg(prev => ({
      ...prev,
      [procKey]: {
        ...prev[procKey],
        attributes: { ...prev[procKey].attributes, [attrName]: value },
      },
    })), [])

  const runEstimate = useCallback(() => {
    const body = buildEstimateBody(receivers, config, resourceProcs, resourceCfg)
    setEstimating(true)
    setEstimateError(null)
    fetch('/estimate?docs=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(data => { setResults(data); setEstimating(false) })
      .catch(err => { setEstimateError(err.message); setEstimating(false) })
  }, [receivers, config, resourceProcs, resourceCfg])

  if (loading) return <div className="status">Loading receivers…</div>
  if (error)   return <div className="status error">Error: {error}</div>

  // ── Results screen ──────────────────────────────────────────────────────────
  if (results) {
    return <EstimateResults results={results} onBack={() => setResults(null)} />
  }

  // ── Config screen ───────────────────────────────────────────────────────────
  const enabledCount = Object.values(config).filter(c => c.enabled).length

  return (
    <div className="app">
      <header className="app-header">
        <h1>OTel Receiver Estimator</h1>
        <span className="badge">{enabledCount} / {receivers.length} selected</span>
        <div className="header-spacer" />
        {estimateError && <span className="estimate-error">{estimateError}</span>}
        <button
          className="estimate-btn"
          onClick={runEstimate}
          disabled={estimating || enabledCount === 0}
        >
          {estimating ? 'Estimating…' : 'Estimate →'}
        </button>
      </header>
      <main>
        <ResourceAttrsPanel
          processors={resourceProcs}
          config={resourceCfg}
          onToggleProcessor={toggleProcessor}
          onToggleAttr={toggleAttr}
        />

        <table className="receiver-table">
          <thead>
            <tr>
              <th className="col-toggle" />
              <th className="col-chevron" />
              <th className="col-name">Receiver</th>
              <th className="col-desc">Description</th>
            </tr>
          </thead>
          <tbody>
            {receivers.map(recv => (
              <ReceiverRow
                key={recv.name}
                receiver={recv}
                cfg={config[recv.name]}
                onUpdate={patch => updateReceiver(recv.name, patch)}
                onUpdateScraper={(sName, patch) => updateScraper(recv.name, sName, patch)}
                onUpdateCardinality={(sName, aName, count) => updateCardinality(recv.name, sName, aName, count)}
              />
            ))}
          </tbody>
        </table>
      </main>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import ReceiverRow from './ReceiverRow'
import ResourceAttrsPanel from './ResourceAttrsPanel'
import EstimateResults from './EstimateResults'
import AddReceiverModal from './AddReceiverModal'
import SimpleMode from './SimpleMode'
import './App.css'

let _nextId = 1
const genId = () => _nextId++

function initScrapersForReceiver(recv) {
  const scrapers = {}
  for (const s of (recv.scrapers || [])) {
    const cardinality = {}
    for (const a of (s.attributes || [])) {
      cardinality[a.name] = a.default_cardinality ?? ((a.values && a.values.length > 0) ? a.values.length : 1)
    }
    const resourceAttrs = {}
    for (const a of (s.resource_attributes?.attributes || [])) {
      resourceAttrs[a.name] = true
    }
    const metrics = {}
    for (const m of (s.metrics || [])) {
      metrics[m.name] = m.default_enabled !== false
    }
    scrapers[s.name] = {
      enabled:  s.default_enabled ?? true,
      pollingS: s.default_polling_interval_s ?? 60,
      cardinality,
      resourceAttrs,
      metrics,
    }
  }
  return scrapers
}

// Initialize scrapers using catalog defaults then apply overrides from the simple-mode source config.
function initScrapersFromSource(recv, sourceReceiverDef) {
  const scrapers = initScrapersForReceiver(recv)
  const sourceCfgScrapers = sourceReceiverDef?.scrapers
  if (!sourceCfgScrapers) return scrapers

  const listedNames = Object.keys(sourceCfgScrapers)
  for (const name of Object.keys(scrapers)) {
    if (!sourceCfgScrapers[name]) {
      // Disable scrapers not listed in the source config
      scrapers[name] = { ...scrapers[name], enabled: false }
    } else {
      const override = sourceCfgScrapers[name]

      // Apply cardinality overrides
      const newCardinality = { ...scrapers[name].cardinality }
      for (const [attrName, attrCfg] of Object.entries(override.attributes || {})) {
        if (attrCfg?.cardinality != null) newCardinality[attrName] = attrCfg.cardinality
      }

      // Apply metric filter — enable only listed metrics, disable the rest
      const metricsList = override.metrics
      const newMetrics = { ...scrapers[name].metrics }
      if (Array.isArray(metricsList) && metricsList.length > 0) {
        for (const mName of Object.keys(newMetrics)) {
          newMetrics[mName] = metricsList.includes(mName)
        }
      }

      scrapers[name] = {
        ...scrapers[name],
        enabled: true,
        cardinality: newCardinality,
        metrics: newMetrics,
      }
    }
  }
  // eslint-disable-next-line no-unused-vars
  void listedNames
  return scrapers
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

// Apply the simple-mode template environments to an initial resourceCfg.
// Envs with enabled:false are auto-applied (always on, not user-toggleable).
// Envs without enabled:false start disabled.
function applySimpleEnvDefaults(initialCfg, environments) {
  const cfg = { ...initialCfg }
  const simpleEnvs = {}

  for (const env of (environments || [])) {
    const forcedOn = env.enabled === false
    simpleEnvs[env.name] = forcedOn ? true : false
    const proc = env.processor
    if (!cfg[proc]) continue

    if (!forcedOn) {
      const newAttrs = {}
      for (const name of Object.keys(cfg[proc].attributes || {})) {
        newAttrs[name] = false
      }
      cfg[proc] = { ...cfg[proc], enabled: false, attributes: newAttrs }
    } else if (env.attributes) {
      // Forced-on env with explicit attribute list: only those attrs are on
      const envAttrs = new Set(env.attributes)
      const newAttrs = {}
      for (const name of Object.keys(cfg[proc].attributes || {})) {
        newAttrs[name] = envAttrs.has(name)
      }
      cfg[proc] = { ...cfg[proc], enabled: true, attributes: newAttrs }
    } else {
      // Forced-on env with no explicit attribute list: use catalog defaults (already in cfg)
      cfg[proc] = { ...cfg[proc], enabled: true }
    }
  }

  return { cfg, simpleEnvs }
}

function buildEstimateBody(configured, receiverCatalog, resourceProcs, resourceCfg) {
  const resource_attributes = []
  for (const proc of resourceProcs) {
    const pcfg = resourceCfg[proc.processor]
    if (!pcfg?.enabled) continue
    for (const [name, on] of Object.entries(pcfg.attributes || {})) {
      if (on) resource_attributes.push(name)
    }
  }

  const recvList = []
  for (const entry of configured) {
    const recv = receiverCatalog.find(r => r.name === entry.receiverName)
    if (!recv) continue
    const scrapers = []
    for (const scraper of (recv.scrapers || [])) {
      const scfg = entry.scrapers?.[scraper.name]
      if (!scfg?.enabled) continue
      const raAttrs = scraper.resource_attributes?.attributes || []
      const enabledRaNames = raAttrs
        .filter(a => scfg.resourceAttrs?.[a.name] !== false)
        .map(a => a.name)
      const metricNames = (scraper.metrics || []).map(m => m.name)
      const enabledMetrics = metricNames.filter(name => scfg.metrics?.[name] !== false)
      scrapers.push({
        name:             scraper.name,
        polling_interval: scfg.pollingS,
        attributes:       Object.fromEntries(
          Object.entries(scfg.cardinality).map(([k, v]) => [k, { cardinality: v }])
        ),
        ...(raAttrs.length > 0 && { resource_attributes: enabledRaNames }),
        ...(metricNames.length > 0 && { metrics: enabledMetrics }),
      })
    }
    const item = { name: entry.receiverName, instances: entry.instances, scrapers }
    if (entry.purpose) item.purpose = entry.purpose
    recvList.push(item)
  }

  return { resource_attributes, receivers: recvList }
}

export default function App() {
  const [receivers, setReceivers]         = useState([])
  const [configured, setConfigured]       = useState([])
  const [resourceProcs, setResourceProcs] = useState([])
  const [resourceCfg, setResourceCfg]     = useState({})
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState(null)
  const [showAddModal, setShowAddModal]   = useState(false)

  const [estimating, setEstimating]       = useState(false)
  const [estimateError, setEstimateError] = useState(null)
  const [results, setResults]             = useState(null)

  // Simple mode state
  const [mode, setMode]               = useState('simple')   // 'simple' | 'advanced'
  const [templates, setTemplates]     = useState([])
  const [simpleEnvs, setSimpleEnvs]   = useState({})
  const [simpleInputs, setSimpleInputs] = useState({})

  useEffect(() => {
    fetch('/receivers')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(data => {
        const sorted = [...(data.receivers || data)].sort((a, b) => a.name.localeCompare(b.name))
        setReceivers(sorted)

        const procs = data.resource_attributes || []
        setResourceProcs(procs)

        const tmpl = data.templates || []
        setTemplates(tmpl)

        // Build base resourceCfg then apply simple-mode env defaults
        const baseCfg = initResourceAttrsConfig(procs)
        const allEnvs = tmpl.find(t => t.environments)?.environments || []
        const { cfg, simpleEnvs: initEnvs } = applySimpleEnvDefaults(baseCfg, allEnvs)
        setResourceCfg(cfg)
        setSimpleEnvs(initEnvs)

        setLoading(false)
      })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [])

  const addReceiver = useCallback((receiverName) => {
    setConfigured(prev => {
      const recv = receivers.find(r => r.name === receiverName)
      if (!recv) return prev
      return [...prev, {
        id:           genId(),
        receiverName,
        purpose:      '',
        expanded:     false,
        instances:    1,
        scrapers:     initScrapersForReceiver(recv),
      }]
    })
  }, [receivers])

  const removeReceiver = useCallback((id) => {
    setConfigured(prev => prev.filter(e => e.id !== id))
  }, [])

  const updateConfigured = useCallback((id, patch) => {
    setConfigured(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e))
  }, [])

  const updateScraper = useCallback((id, scraperName, patch) => {
    setConfigured(prev => prev.map(e => {
      if (e.id !== id) return e
      return { ...e, scrapers: { ...e.scrapers, [scraperName]: { ...e.scrapers[scraperName], ...patch } } }
    }))
  }, [])

  const updateCardinality = useCallback((id, scraperName, attrName, count) => {
    setConfigured(prev => prev.map(e => {
      if (e.id !== id) return e
      return {
        ...e,
        scrapers: {
          ...e.scrapers,
          [scraperName]: {
            ...e.scrapers[scraperName],
            cardinality: { ...e.scrapers[scraperName].cardinality, [attrName]: count },
          },
        },
      }
    }))
  }, [])

  const updateResourceAttr = useCallback((id, scraperName, attrName, enabled) => {
    setConfigured(prev => prev.map(e => {
      if (e.id !== id) return e
      return {
        ...e,
        scrapers: {
          ...e.scrapers,
          [scraperName]: {
            ...e.scrapers[scraperName],
            resourceAttrs: { ...e.scrapers[scraperName].resourceAttrs, [attrName]: enabled },
          },
        },
      }
    }))
  }, [])

  const toggleProcessor = useCallback((procKey, field, value) => {
    setResourceCfg(prev => {
      const updated = { ...prev, [procKey]: { ...prev[procKey], [field]: value } }
      // When enabling a processor, restore each attribute's default_enabled from the catalog
      if (field === 'enabled' && value === true) {
        const procDef = resourceProcs.find(p => p.processor === procKey)
        if (procDef) {
          const defaultAttrs = {}
          for (const attr of (procDef.attributes || [])) {
            defaultAttrs[attr.name] = attr.default_enabled ?? true
          }
          updated[procKey] = { ...updated[procKey], attributes: defaultAttrs }
        }
      }
      return updated
    })
  }, [resourceProcs])

  const toggleAttr = useCallback((procKey, attrName, value) =>
    setResourceCfg(prev => ({
      ...prev,
      [procKey]: { ...prev[procKey], attributes: { ...prev[procKey].attributes, [attrName]: value } },
    })), [])

  // Simple mode: toggle an environment on/off and sync to resourceCfg
  const toggleSimpleEnv = useCallback((envName, enabled) => {
    setSimpleEnvs(prev => ({ ...prev, [envName]: enabled }))

    const allEnvs = templates.find(t => t.environments)?.environments || []
    const env = allEnvs.find(e => e.name === envName)
    if (!env) return

    setResourceCfg(prev => {
      const proc = env.processor
      if (!prev[proc]) return prev
      if (!enabled) {
        return { ...prev, [proc]: { ...prev[proc], enabled: false } }
      }
      // Restore each attribute's default_enabled from the catalog (same as advanced mode)
      const procDef = resourceProcs.find(p => p.processor === proc)
      const defaultAttrs = {}
      for (const attr of (procDef?.attributes || [])) {
        defaultAttrs[attr.name] = attr.default_enabled ?? true
      }
      return { ...prev, [proc]: { ...prev[proc], enabled: true, attributes: defaultAttrs } }
    })
  }, [templates, resourceProcs])

  // Simple mode: change a source input quantity and sync to configured receivers
  const setSimpleInput = useCallback((sourceName, inputIndex, quantity) => {
    setSimpleInputs(prev => ({
      ...prev,
      [sourceName]: { ...(prev[sourceName] || {}), [inputIndex]: quantity },
    }))

    const allSources = templates.find(t => t.sources)?.sources || []
    const source = allSources.find(s => s.name === sourceName)
    if (!source) return

    const input = (source.inputs || [])[inputIndex]
    if (!input?.map) return

    // Parse "receiverName/field" from the map value
    const slashIdx = input.map.lastIndexOf('/')
    const receiverName = input.map.slice(0, slashIdx)
    const field = input.map.slice(slashIdx + 1)
    if (field !== 'quantity') return

    const sourceReceiverDef = (source.receivers || []).find(r => r.name === receiverName)

    if (quantity <= 0) {
      setConfigured(prev => prev.filter(e => e.receiverName !== receiverName))
      return
    }

    setConfigured(prev => {
      const existing = prev.find(e => e.receiverName === receiverName)
      if (existing) {
        return prev.map(e => e.receiverName === receiverName ? { ...e, instances: quantity } : e)
      }
      const recv = receivers.find(r => r.name === receiverName)
      if (!recv) return prev
      return [...prev, {
        id:           genId(),
        receiverName,
        purpose:      '',
        expanded:     false,
        instances:    quantity,
        scrapers:     initScrapersFromSource(recv, sourceReceiverDef),
      }]
    })
  }, [templates, receivers])

  const runEstimate = useCallback(() => {
    const body = buildEstimateBody(configured, receivers, resourceProcs, resourceCfg)
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
  }, [configured, receivers, resourceProcs, resourceCfg])

  if (loading) return <div className="status">Loading receivers…</div>
  if (error)   return <div className="status error">Error: {error}</div>

  if (results) {
    return <EstimateResults results={results} onBack={() => setResults(null)} />
  }

  const hasTemplates = templates.length > 0

  return (
    <div className="app">
      <header className="app-header">
        <h1>OTel Receiver Estimator</h1>
        {hasTemplates && (
          <div className="mode-toggle">
            <button
              className={`mode-btn ${mode === 'simple' ? 'mode-btn-active' : ''}`}
              onClick={() => setMode('simple')}
            >Simple</button>
            <button
              className={`mode-btn ${mode === 'advanced' ? 'mode-btn-active' : ''}`}
              onClick={() => setMode('advanced')}
            >Advanced</button>
          </div>
        )}
        <span className="badge">
          {configured.length} receiver{configured.length !== 1 ? 's' : ''} configured
        </span>
        <div className="header-spacer" />
        {estimateError && <span className="estimate-error">{estimateError}</span>}
        <button
          className="estimate-btn"
          onClick={runEstimate}
          disabled={estimating || configured.length === 0}
        >
          {estimating ? 'Estimating…' : 'Estimate →'}
        </button>
      </header>

      <main>
        {mode === 'simple' && hasTemplates ? (
          <SimpleMode
            templates={templates}
            simpleEnvs={simpleEnvs}
            simpleInputs={simpleInputs}
            onToggleEnv={toggleSimpleEnv}
            onSetInput={setSimpleInput}
          />
        ) : (
          <>
            <ResourceAttrsPanel
              processors={resourceProcs}
              config={resourceCfg}
              onToggleProcessor={toggleProcessor}
              onToggleAttr={toggleAttr}
            />

            {configured.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📡</div>
                <p className="empty-state-text">No receivers configured yet.</p>
                <button className="add-receiver-btn" onClick={() => setShowAddModal(true)}>
                  + Add Receiver
                </button>
              </div>
            ) : (
              <>
                <table className="receiver-table">
                  <thead>
                    <tr>
                      <th className="col-remove" />
                      <th className="col-chevron" />
                      <th className="col-name">Receiver</th>
                      <th className="col-desc">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configured.map(entry => {
                      const recv = receivers.find(r => r.name === entry.receiverName)
                      if (!recv) return null
                      return (
                        <ReceiverRow
                          key={entry.id}
                          receiver={recv}
                          cfg={entry}
                          onUpdate={patch => updateConfigured(entry.id, patch)}
                          onUpdateScraper={(sName, patch) => updateScraper(entry.id, sName, patch)}
                          onUpdateCardinality={(sName, aName, count) => updateCardinality(entry.id, sName, aName, count)}
                          onUpdateResourceAttr={(sName, aName, enabled) => updateResourceAttr(entry.id, sName, aName, enabled)}
                          onRemove={() => removeReceiver(entry.id)}
                        />
                      )
                    })}
                  </tbody>
                </table>
                <div className="add-receiver-row">
                  <button className="add-receiver-inline-btn" onClick={() => setShowAddModal(true)}>
                    + Add Receiver
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </main>

      {showAddModal && (
        <AddReceiverModal
          receivers={receivers}
          onAdd={addReceiver}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  )
}

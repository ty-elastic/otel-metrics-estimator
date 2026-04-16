import { useState } from 'react'

function fmt(gb) {
  if (gb === null || gb === undefined) return '—'
  if (gb >= 1)      return gb.toFixed(3) + ' GB'
  if (gb >= 0.001)  return (gb * 1000).toFixed(3) + ' MB'
  return (gb * 1e6).toFixed(1) + ' KB'
}

function fmtDocs(n) {
  if (n === null || n === undefined) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function DocRow({ doc, index, scraperResourceAttrs }) {
  const [expanded, setExpanded] = useState(false)
  const metrics = Object.keys(doc.metrics || {})
  const attrs = Object.entries(doc.attributes || {})
  const docResAttrs = doc.resource?.attributes || {}
  const firstResAttrName = (scraperResourceAttrs || []).find(name => name in docResAttrs)
  const resAttrEntry = firstResAttrName != null
    ? [[firstResAttrName, docResAttrs[firstResAttrName]]]
    : []

  return (
    <div className="doc-item">
      <button className={`doc-toggle ${expanded ? 'open' : ''}`} onClick={() => setExpanded(e => !e)}>
        <span className="chevron-icon">▶</span>
        <span className="doc-label">Doc {index + 1}</span>
        {metrics.length > 0 && (
          <span className="doc-metrics">
            {metrics.map(m => <span key={m} className="doc-metric-name">{m}</span>)}
          </span>
        )}
        {attrs.length > 0 && (
          <span className="doc-attrs">
            {attrs.map(([k, v]) => (
              <span key={k} className="doc-attr-pair">
                <span className="doc-attr-key">{k}</span>
                <span className="doc-attr-eq">=</span>
                <span className="doc-attr-val">{String(v)}</span>
              </span>
            ))}
          </span>
        )}
        {resAttrEntry.length > 0 && (
          <span className="doc-res-attrs">
            {resAttrEntry.map(([k, v]) => (
              <span key={k} className="doc-res-attr-pair">
                <span className="doc-res-attr-key">{k}</span>
                <span className="doc-res-attr-eq">=</span>
                <span className="doc-res-attr-val">{String(v)}</span>
              </span>
            ))}
          </span>
        )}
      </button>
      {expanded && (
        <pre className="doc-json">{JSON.stringify(doc, null, 2)}</pre>
      )}
    </div>
  )
}

function ScraperResultRow({ scraper }) {
  const [docsExpanded, setDocsExpanded] = useState(false)
  const docs = scraper.docs || []
  const hasDocs = docs.length > 0

  return (
    <>
      <tr className="scraper-result-row">
        <td className="res-chevron-cell">
          {hasDocs && (
            <button
              className={`chevron-btn ${docsExpanded ? 'open' : ''}`}
              onClick={() => setDocsExpanded(e => !e)}
              aria-label={docsExpanded ? 'Collapse docs' : 'Expand docs'}
            >▶</button>
          )}
        </td>
        <td className="res-scraper-name">{scraper.name}</td>
        <td className="res-num">{scraper.polling_interval_s != null ? `${scraper.polling_interval_s}s` : '—'}</td>
        <td className="res-num">{fmtDocs(scraper.time_series)}</td>
        <td className="res-num">{fmtDocs(scraper.data_points_per_day)}</td>
        <td className="res-num">{fmt(scraper.json_gb_per_day)}</td>
        <td className="res-num">{fmt(scraper.metered_gb_per_day)}</td>
      </tr>
      {docsExpanded && hasDocs && (
        <tr className="scraper-docs-row">
          <td colSpan={7}>
            <div className="docs-panel">
              <div className="docs-panel-title">docs ({docs.length})</div>
              <div className="docs-list">
                {docs.map((doc, i) => (
                  <DocRow key={i} doc={doc} index={i} scraperResourceAttrs={scraper.resource_attributes} />
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function ReceiverResultRow({ receiver }) {
  const [expanded, setExpanded] = useState(false)
  const hasScrapers = receiver.scrapers && receiver.scrapers.length > 0

  return (
    <>
      <tr className={`res-recv-row ${expanded ? 'res-recv-expanded' : ''}`}>
        <td className="res-chevron-cell">
          {hasScrapers && (
            <button
              className={`chevron-btn ${expanded ? 'open' : ''}`}
              onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >▶</button>
          )}
        </td>
        <td className="res-recv-name">{receiver.name}</td>
        <td className="res-num">{receiver.instances ?? 1}</td>
        <td className="res-num">{fmtDocs(receiver.time_series)}</td>
        <td className="res-num">{fmtDocs(receiver.data_points_per_day)}</td>
        <td className="res-num">{fmt(receiver.json_gb_per_day)}</td>
        <td className="res-num res-highlight">{fmt(receiver.metered_gb_per_day)}</td>
      </tr>
      {expanded && hasScrapers && (
        <tr className="res-scraper-detail-row">
          <td colSpan={7}>
            <div className="res-scraper-detail">
              <table className="res-scraper-table">
                <thead>
                  <tr>
                    <th className="res-chevron-cell" />
                    <th>Scraper</th>
                    <th className="res-num">Polling</th>
                    <th className="res-num">Time Series</th>
                    <th className="res-num">Data Points / day</th>
                    <th className="res-num">JSON GB/day</th>
                    <th className="res-num">Metered GB/day</th>
                  </tr>
                </thead>
                <tbody>
                  {receiver.scrapers.map(s => (
                    <ScraperResultRow key={s.name} scraper={s} />
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function EstimateResults({ results, onBack }) {
  if (!results) return null

  const sorted = [...(results.receivers || [])].sort(
    (a, b) => (b.metered_gb_per_day ?? 0) - (a.metered_gb_per_day ?? 0)
  )

  return (
    <div className="app">
      <header className="app-header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1>Estimation Results</h1>
      </header>
      <main>
        {/* Summary cards */}
        <div className="res-summary">
          <div className="res-card">
            <div className="res-card-label">Time Series</div>
            <div className="res-card-value">{fmtDocs(results.total_time_series)}</div>
            <div className="res-card-unit">unique</div>
          </div>
          <div className="res-card">
            <div className="res-card-label">Data Points</div>
            <div className="res-card-value">{fmtDocs(results.total_data_points_per_day)}</div>
            <div className="res-card-unit">per day</div>
          </div>
          <div className="res-card">
            <div className="res-card-label">Total JSON</div>
            <div className="res-card-value">{fmt(results.total_json_gb_per_day)}</div>
            <div className="res-card-unit">per day</div>
          </div>
          <div className="res-card res-card-accent">
            <div className="res-card-label">Total Metered</div>
            <div className="res-card-value">{fmt(results.total_metered_gb_per_day)}</div>
            <div className="res-card-unit">per day</div>
          </div>
          <div className="res-card">
            <div className="res-card-label">Receivers</div>
            <div className="res-card-value">{sorted.length}</div>
            <div className="res-card-unit">configured</div>
          </div>
        </div>

        {/* Per-receiver table */}
        <table className="res-recv-table">
          <thead>
            <tr>
              <th className="res-chevron-cell" />
              <th>Receiver</th>
              <th className="res-num">Instances</th>
              <th className="res-num">Time Series</th>
              <th className="res-num">Data Points / day</th>
              <th className="res-num">JSON GB / day</th>
              <th className="res-num">Metered GB / day</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(recv => (
              <ReceiverResultRow key={recv.name} receiver={recv} />
            ))}
          </tbody>
        </table>
      </main>
    </div>
  )
}

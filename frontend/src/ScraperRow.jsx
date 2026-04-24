export default function ScraperRow({ scraper, cfg, onUpdate, onUpdateCardinality, onUpdateResourceAttr }) {
  if (!cfg) return null

  const attrs    = scraper.attributes || []
  const resAttrs = scraper.resource_attributes?.attributes || []
  const metrics  = scraper.metrics || []   // [{name, description, default_enabled}]

  const hasContent = attrs.length > 0 || resAttrs.length > 0 || metrics.length > 0

  return (
    <tr className={`scraper-row ${cfg.enabled ? 'scraper-on' : ''}`}>
      <td className="col-toggle">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={() => onUpdate({ enabled: !cfg.enabled })}
        />
      </td>
      <td className="col-name scraper-name">{scraper.name}</td>
      <td>
        <label className="inline-field">
          <input
            type="number"
            className="polling-input"
            value={cfg.pollingS}
            min={1}
            onChange={e => onUpdate({ pollingS: Math.max(1, Number(e.target.value)) })}
          />
          <span className="unit">s</span>
        </label>
      </td>
      <td>
        {!hasContent
          ? <span className="no-desc">none</span>
          : (
            <>
              {attrs.length > 0 && (
                <table className="attr-table">
                  <colgroup>
                    <col className="attr-col-name" />
                    <col className="attr-col-desc" />
                    <col className="attr-col-card" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Attribute</th>
                      <th>Description</th>
                      <th className="attr-th-card">Cardinality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attrs.map(attr => (
                      <tr key={attr.name}>
                        <td className="attr-name">{attr.name}</td>
                        <td className="attr-desc">
                          {attr.description || <span className="no-desc">—</span>}
                          {attr.type === 'enum' && (
                            <span className="enum-badge" title={attr.values?.join(', ')}>
                              enum ({attr.values?.length})
                            </span>
                          )}
                        </td>
                        <td>
                          <input
                            type="number"
                            className="cardinality-input"
                            value={cfg.cardinality?.[attr.name] ?? 1}
                            min={1}
                            onChange={e => onUpdateCardinality(attr.name, Math.max(1, Number(e.target.value)))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {resAttrs.length > 0 && (
                <table className="attr-table res-attr-table">
                  <colgroup>
                    <col className="attr-col-toggle" />
                    <col className="attr-col-name" />
                    <col className="attr-col-desc" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th />
                      <th>Resource Attribute</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resAttrs.map(attr => (
                      <tr key={attr.name}>
                        <td className="col-toggle">
                          <input
                            type="checkbox"
                            checked={cfg.resourceAttrs?.[attr.name] !== false}
                            onChange={e => onUpdateResourceAttr(attr.name, e.target.checked)}
                          />
                        </td>
                        <td className="attr-name">{attr.name}</td>
                        <td className="attr-desc">
                          {attr.description || <span className="no-desc">—</span>}
                          {attr.type === 'enum' && (
                            <span className="enum-badge" title={attr.values?.join(', ')}>
                              enum ({attr.values?.length})
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {metrics.length > 0 && (
                <table className="attr-table metrics-table">
                  <colgroup>
                    <col className="attr-col-name" />
                    <col className="attr-col-desc" />
                    <col className="attr-col-card" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Description</th>
                      <th className="attr-th-card">Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(m => (
                      <tr key={m.name} className={cfg.metrics?.[m.name] === false ? 'metric-row-off' : ''}>
                        <td className="attr-name">{m.name}</td>
                        <td className="attr-desc">
                          {m.description || <span className="no-desc">—</span>}
                        </td>
                        <td className="attr-td-card">
                          <input
                            type="checkbox"
                            checked={cfg.metrics?.[m.name] !== false}
                            onChange={e => onUpdate({
                              metrics: { ...cfg.metrics, [m.name]: e.target.checked }
                            })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )
        }
      </td>
    </tr>
  )
}

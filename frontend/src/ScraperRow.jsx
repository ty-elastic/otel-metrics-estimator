export default function ScraperRow({ scraper, cfg, onUpdate, onUpdateCardinality }) {
  if (!cfg) return null

  const attrs = scraper.attributes || []
  const resAttrs = scraper.resource_attributes?.attributes || []

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
        {attrs.length === 0 && resAttrs.length === 0
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
                    <col className="attr-col-name" />
                    <col className="attr-col-desc" />
                    <col className="attr-col-card" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Resource Attribute</th>
                      <th>Description</th>
                      <th className="attr-th-card">
                        <label className="inline-field res-attr-card-label">
                          Cardinality
                          <input
                            type="number"
                            className="cardinality-input"
                            value={cfg.resourceAttributesCardinality ?? 1}
                            min={1}
                            onChange={e => onUpdate({ resourceAttributesCardinality: Math.max(1, Number(e.target.value)) })}
                          />
                        </label>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {resAttrs.map(attr => (
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
                        <td />
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
